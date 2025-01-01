const puppeteer = require('puppeteer');
const redis = require('redis');
const moment = require('moment');

// Configuração do Redis
const redisClient = redis.createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});

redisClient.on('error', (err) => console.log('Redis Client Error', err));

async function connectRedis() {
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }
}

async function getCachedData(key) {
  await connectRedis();
  const data = await redisClient.get(key);
  return data ? JSON.parse(data) : null;
}

async function setCachedData(key, data, ttl = 7200) { // 2 horas de cache
  await connectRedis();
  await redisClient.setEx(key, ttl, JSON.stringify(data));
}

async function buscarVideos(keyword, maxVideos = 10, options = {}) {
  // Verifica cache primeiro
  const cacheKey = `youtube:${keyword}:${maxVideos}`;
  const cachedResult = await getCachedData(cacheKey);
  if (cachedResult) {
    return { ...cachedResult, fromCache: true };
  }

  const { minDuration, maxDuration, dateFilter } = options;
  
  const browserOptions = {
    headless: "new",
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1920x1080',
    ]
  };

  if (process.env.RAILWAY_ENVIRONMENT === 'production') {
    browserOptions.executablePath = '/usr/bin/google-chrome-stable';
  }

  let browser;
  try {
    let retries = 3;
    while (retries > 0) {
      try {
        browser = await puppeteer.launch(browserOptions);
        break;
      } catch (err) {
        retries--;
        if (retries === 0) throw err;
        console.log(`Falha ao iniciar browser, tentativas restantes: ${retries}`);
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    const page = await browser.newPage();
    
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const resourceType = request.resourceType();
      if (['image', 'stylesheet', 'font'].includes(resourceType)) {
        request.abort();
      } else {
        request.continue();
      }
    });

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(keyword)}`;
    await page.goto(url, { 
      waitUntil: 'networkidle2', 
      timeout: process.env.RAILWAY_ENVIRONMENT === 'production' ? 60000 : 30000 
    });

    await page.waitForSelector('#video-title', { 
      timeout: process.env.RAILWAY_ENVIRONMENT === 'production' ? 20000 : 10000 
    });

    async function scrollUntilMaxVideos() {
      let previousHeight;
      let videoCount = 0;
      const maxScrollAttempts = 10;
      let scrollAttempts = 0;
      
      while (videoCount < maxVideos && scrollAttempts < maxScrollAttempts) {
        videoCount = await page.evaluate(() => document.querySelectorAll('ytd-video-renderer').length);
        
        if (videoCount >= maxVideos) break;
        
        previousHeight = await page.evaluate('document.documentElement.scrollHeight');
        await page.evaluate('window.scrollTo(0, document.documentElement.scrollHeight)');
        await page.waitForTimeout(1500);
        
        const newHeight = await page.evaluate('document.documentElement.scrollHeight');
        if (newHeight === previousHeight) break;
        
        scrollAttempts++;
      }
    }

    await scrollUntilMaxVideos();

    // Extrair dados mais detalhados dos vídeos
    const videos = await page.evaluate((maxVideos) => {
      const videoElements = Array.from(document.querySelectorAll('ytd-video-renderer')).slice(0, maxVideos);
      
      return videoElements.map(videoEl => {
        try {
          const titleEl = videoEl.querySelector('#video-title');
          const viewsEl = videoEl.querySelector('#metadata-line span:first-child');
          const thumbnailEl = videoEl.querySelector('#thumbnail img');
          const channelEl = videoEl.querySelector('#channel-name a, #text-container a');
          const durationEl = videoEl.querySelector('span.ytd-thumbnail-overlay-time-status-renderer');
          const publishedEl = videoEl.querySelector('#metadata-line span:last-child');
          const descriptionEl = videoEl.querySelector('#description-text, #description');
          const badgeEl = videoEl.querySelector('ytd-badge-supported-renderer');
          
          // Extrair hashtags do título
          const title = titleEl ? titleEl.innerText.trim() : 'N/A';
          const hashtags = title.match(/#\w+/g) || [];
          
          // Processar visualizações para número
          const viewsText = viewsEl ? viewsEl.innerText.trim() : '0';
          const viewsNumber = parseInt(viewsText.replace(/[^0-9]/g, '')) || 0;
          
          // Processar data de publicação
          const publishedText = publishedEl ? publishedEl.innerText.trim() : '';
          const publishedDate = publishedText.includes('há') ? 
            moment().subtract(
              parseInt(publishedText.match(/\d+/)[0]),
              publishedText.includes('hora') ? 'hours' : 
              publishedText.includes('dia') ? 'days' : 
              publishedText.includes('semana') ? 'weeks' : 
              publishedText.includes('mês') ? 'months' : 'years'
            ).format('YYYY-MM-DD HH:mm:ss') : 
            null;

          // Processar thumbnail
          const thumbnailSrc = thumbnailEl ? 
            (thumbnailEl.src.startsWith('data:') ? thumbnailEl.dataset.thumbnailUrl : thumbnailEl.src) : 
            'N/A';

          // Processar nome do canal
          const channelName = channelEl ? channelEl.innerText.trim() : 
            (videoEl.querySelector('#channel-name') ? videoEl.querySelector('#channel-name').innerText.trim() : 'N/A');

          return {
            titulo: title,
            link: titleEl ? titleEl.href : 'N/A',
            visualizacoes: viewsText,
            visualizacoesNumero: viewsNumber,
            thumbnail: thumbnailSrc,
            canal: {
              nome: channelName,
              link: channelEl ? channelEl.href : 'N/A',
              verificado: !!badgeEl
            },
            duracao: durationEl ? durationEl.innerText.trim() : 'N/A',
            publicadoEm: publishedDate,
            descricao: descriptionEl ? descriptionEl.innerText.trim() : 'N/A',
            hashtags: hashtags,
            categoria: 'N/A',
            metricas: {
              visualizacoesPorDia: 0,
              engajamento: 0
            }
          };
        } catch (err) {
          console.error('Erro ao extrair dados do vídeo:', err);
          return null;
        }
      }).filter(video => video !== null);
    }, maxVideos);

    // Enriquecer dados visitando cada vídeo
    for (let i = 0; i < videos.length; i++) {
      const video = videos[i];
      try {
        console.log(`Coletando dados adicionais do vídeo ${i + 1}/${videos.length}: ${video.titulo}`);
        
        await page.goto(video.link, { 
          waitUntil: 'networkidle2', 
          timeout: process.env.RAILWAY_ENVIRONMENT === 'production' ? 45000 : 30000 
        });
        
        // Aguardar elementos importantes
        await page.waitForSelector('ytd-watch-metadata', { timeout: 10000 });
        
        const extraInfo = await page.evaluate(() => {
          // Função helper para extrair números
          const extractNumber = (text) => parseInt(text.replace(/[^0-9]/g, '')) || 0;
          
          // Coletar likes
          const likesEl = document.querySelector('#top-level-buttons-computed ytd-toggle-button-renderer:first-child #text');
          const likes = likesEl ? likesEl.innerText.trim() : 'N/A';
          const likesNumber = likesEl ? extractNumber(likes) : 0;
          
          // Coletar comentários
          const commentsEl = document.querySelector('#comments #count .count-text');
          const comments = commentsEl ? commentsEl.innerText.trim() : 'N/A';
          const commentsNumber = commentsEl ? extractNumber(comments) : 0;
          
          // Coletar descrição completa
          const descriptionEl = document.querySelector('#description-inline-expander, #description');
          const description = descriptionEl ? descriptionEl.innerText.trim() : 'N/A';
          
          // Coletar categoria
          const categoryEl = document.querySelector('ytd-metadata-row-renderer:has(#title yt-formatted-string:contains("Categoria")) #content');
          const category = categoryEl ? categoryEl.innerText.trim() : 'N/A';
          
          return {
            likes,
            likesNumber,
            comentarios: comments,
            comentariosNumber: commentsNumber,
            descricao: description,
            categoria: category
          };
        });

        // Atualizar dados do vídeo
        video.likes = extraInfo.likes;
        video.likesNumero = extraInfo.likesNumber;
        video.comentarios = extraInfo.comentarios;
        video.comentariosNumero = extraInfo.commentsNumber;
        video.descricao = extraInfo.descricao;
        video.categoria = extraInfo.categoria;

        // Calcular métricas
        if (video.publicadoEm && video.visualizacoesNumero) {
          const diasDesdePublicacao = moment().diff(moment(video.publicadoEm), 'days') || 1;
          video.metricas.visualizacoesPorDia = Math.round(video.visualizacoesNumero / diasDesdePublicacao);
          
          // Calcular taxa de engajamento (likes + comentários) / visualizações * 100
          const engajamentoTotal = (video.likesNumero + video.comentariosNumero);
          video.metricas.engajamento = video.visualizacoesNumero > 0 ? 
            ((engajamentoTotal / video.visualizacoesNumero) * 100).toFixed(2) + '%' : '0%';
        }

        // Aguardar um pouco entre requisições para evitar bloqueio
        await page.waitForTimeout(1000);
      } catch (err) {
        console.error(`Erro ao enriquecer dados do vídeo ${video.link}:`, err);
      }
    }

    const result = {
      success: true,
      data: videos,
      total: videos.length,
      query: keyword,
      environment: process.env.RAILWAY_ENVIRONMENT || 'development',
      timestamp: new Date().toISOString()
    };

    // Salvar no cache
    await setCachedData(cacheKey, result);

    return result;

  } catch (error) {
    console.error('Erro durante a raspagem:', error);
    return {
      success: false,
      error: error.message,
      query: keyword,
      environment: process.env.RAILWAY_ENVIRONMENT || 'development'
    };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (err) {
        console.error('Erro ao fechar o browser:', err);
      }
    }
  }
}

module.exports = { buscarVideos };
