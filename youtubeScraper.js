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
      function extractViews(element) {
        if (!element) return { text: '0', number: 0 };
        const text = element.innerText.trim();
        const match = text.match(/(\d+(?:\.\d+)?[KMB]?)\s*views?/i);
        if (!match) return { text: '0', number: 0 };
        
        const value = match[1];
        let number = parseFloat(value.replace(/[KMB]/g, ''));
        
        if (value.includes('K')) number *= 1000;
        if (value.includes('M')) number *= 1000000;
        if (value.includes('B')) number *= 1000000000;
        
        return { text: text, number: Math.round(number) };
      }

      const videoElements = Array.from(document.querySelectorAll('ytd-video-renderer')).slice(0, maxVideos);
      
      return videoElements.map(videoEl => {
        try {
          // Seletores principais
          const titleEl = videoEl.querySelector('#video-title');
          const viewsEl = videoEl.querySelector('#metadata-line span');
          const channelEl = videoEl.querySelector('#channel-name a, #text-container a, #channel-name');
          const durationEl = videoEl.querySelector('span.ytd-thumbnail-overlay-time-status-renderer');
          const publishedEl = videoEl.querySelector('#metadata-line span:last-child');
          const thumbnailEl = videoEl.querySelector('#thumbnail img[src]');
          const badgeEl = videoEl.querySelector('ytd-badge-supported-renderer');
          
          // Processamento do título e hashtags
          const title = titleEl ? titleEl.innerText.trim() : 'N/A';
          const hashtags = (title.match(/#\w+/g) || []).concat(
            ((videoEl.querySelector('#description-text') || {}).innerText || '')
              .match(/#\w+/g) || []
          );

          // Processamento de visualizações
          const views = extractViews(viewsEl);
          
          // Processamento de thumbnail
          let thumbnailUrl = '';
          if (thumbnailEl) {
            thumbnailUrl = thumbnailEl.src;
            if (thumbnailUrl.startsWith('data:')) {
              thumbnailUrl = thumbnailEl.dataset.thumbnailUrl || thumbnailEl.dataset.thumb || '';
            }
            // Se ainda estiver vazio, tentar construir a URL da thumbnail
            if (!thumbnailUrl && titleEl && titleEl.href) {
              const videoId = titleEl.href.match(/(?:v=|\/)([\w-]{11})(?:\?|&|\/|$)/);
              if (videoId) {
                thumbnailUrl = `https://i.ytimg.com/vi/${videoId[1]}/hqdefault.jpg`;
              }
            }
          }

          // Processamento do canal
          const channelName = channelEl ? 
            channelEl.innerText.trim() : 
            videoEl.querySelector('#channel-name') ? 
              videoEl.querySelector('#channel-name').innerText.trim() : 'N/A';

          const channelLink = channelEl ? 
            channelEl.href : 
            channelName !== 'N/A' ? 
              `https://www.youtube.com/c/${encodeURIComponent(channelName)}` : 'N/A';

          // Processamento da data de publicação
          const publishedText = publishedEl ? publishedEl.innerText.trim() : '';
          let publishedDate = null;
          
          if (publishedText) {
            const timeMatch = publishedText.match(/(\d+)\s*(minuto|hora|dia|semana|mês|mes|ano)s?\s+atrás/i);
            if (timeMatch) {
              const [_, amount, unit] = timeMatch;
              const unitMap = {
                'minuto': 'minutes',
                'hora': 'hours',
                'dia': 'days',
                'semana': 'weeks',
                'mês': 'months',
                'mes': 'months',
                'ano': 'years'
              };
              publishedDate = moment().subtract(parseInt(amount), unitMap[unit.toLowerCase()]).format('YYYY-MM-DD HH:mm:ss');
            }
          }

          return {
            titulo: title,
            link: titleEl ? titleEl.href : 'N/A',
            visualizacoes: views.text,
            visualizacoesNumero: views.number,
            thumbnail: thumbnailUrl,
            canal: {
              nome: channelName,
              link: channelLink,
              verificado: !!badgeEl
            },
            duracao: durationEl ? durationEl.innerText.trim() : 'N/A',
            publicadoEm: publishedDate,
            descricao: videoEl.querySelector('#description-text') ? 
              videoEl.querySelector('#description-text').innerText.trim() : 'N/A',
            hashtags: [...new Set(hashtags)], // Remove duplicatas
            categoria: 'N/A',
            metricas: {
              visualizacoesPorDia: 0,
              engajamento: '0%'
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
          function extractNumber(text) {
            if (!text) return 0;
            const match = text.match(/(\d+(?:\.\d+)?[KMB]?)/i);
            if (!match) return 0;
            
            const value = match[1];
            let number = parseFloat(value.replace(/[KMB]/g, ''));
            
            if (value.includes('K')) number *= 1000;
            if (value.includes('M')) number *= 1000000;
            if (value.includes('B')) number *= 1000000000;
            
            return Math.round(number);
          }

          // Coletar likes
          const likesEl = document.querySelector('#top-level-buttons-computed ytd-toggle-button-renderer:first-child #text');
          const likes = likesEl ? likesEl.innerText.trim() : 'N/A';
          const likesNumber = extractNumber(likes);
          
          // Coletar comentários
          const commentsEl = document.querySelector('#comments #count .count-text');
          const comments = commentsEl ? commentsEl.innerText.trim() : 'N/A';
          const commentsNumber = extractNumber(comments);
          
          // Coletar descrição completa
          const descriptionEl = document.querySelector('#description-inline-expander, #description');
          const description = descriptionEl ? descriptionEl.innerText.trim() : 'N/A';
          
          // Coletar categoria
          const categoryEl = document.querySelector('ytd-metadata-row-renderer:has(#title yt-formatted-string:contains("Categoria")) #content');
          const category = categoryEl ? categoryEl.innerText.trim() : 'N/A';

          // Coletar visualizações novamente (pode ser mais preciso na página do vídeo)
          const viewsEl = document.querySelector('#info #count .view-count');
          const views = viewsEl ? viewsEl.innerText.trim() : null;
          const viewsNumber = extractNumber(views);
          
          return {
            likes,
            likesNumber,
            comentarios: comments,
            comentariosNumber: commentsNumber,
            descricao: description,
            categoria: category,
            visualizacoes: views,
            visualizacoesNumero: viewsNumber
          };
        });

        // Atualizar dados do vídeo
        video.likes = extraInfo.likes;
        video.likesNumero = extraInfo.likesNumber;
        video.comentarios = extraInfo.comentarios;
        video.comentariosNumero = extraInfo.commentsNumber;
        video.descricao = extraInfo.descricao;
        video.categoria = extraInfo.categoria;

        // Atualizar visualizações se os novos dados forem mais precisos
        if (extraInfo.visualizacoesNumero > 0) {
          video.visualizacoes = extraInfo.visualizacoes;
          video.visualizacoesNumero = extraInfo.visualizacoesNumero;
        }

        // Calcular métricas
        if (video.publicadoEm && video.visualizacoesNumero > 0) {
          const diasDesdePublicacao = moment().diff(moment(video.publicadoEm), 'days') || 1;
          video.metricas.visualizacoesPorDia = Math.round(video.visualizacoesNumero / diasDesdePublicacao);
          
          // Calcular taxa de engajamento (likes + comentários) / visualizações * 100
          const engajamentoTotal = (video.likesNumero + video.comentariosNumero);
          video.metricas.engajamento = video.visualizacoesNumero > 0 ? 
            ((engajamentoTotal / video.visualizacoesNumero) * 100).toFixed(2) + '%' : '0%';
        }

        // Aguardar um pouco entre requisições para evitar bloqueio
        await page.waitForTimeout(1500);
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
