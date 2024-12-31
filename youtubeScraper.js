const puppeteer = require('puppeteer');
const os = require('os');

async function buscarVideos(keyword, maxVideos = 10) {
  const isLinux = os.platform() === 'linux';
  
  const options = {
    headless: "new",
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  };

  // Adiciona o caminho do executável apenas no Linux
  if (isLinux) {
    options.executablePath = '/usr/bin/google-chrome-stable';
  }

  const browser = await puppeteer.launch(options);

  const page = await browser.newPage();

  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(keyword)}`;
  await page.goto(url, { waitUntil: 'networkidle2' });

  await page.waitForSelector('#video-title');

  const videos = await page.evaluate((maxVideos) => {
    const videoElements = Array.from(document.querySelectorAll('ytd-video-renderer')).slice(0, maxVideos);
    
    return videoElements.map(videoEl => {
      const titleEl = videoEl.querySelector('#video-title');
      const viewsEl = videoEl.querySelector('#metadata-line span');
      const thumbnailEl = videoEl.querySelector('#thumbnail img');
      
      return {
        titulo: titleEl ? titleEl.innerText.trim() : 'N/A',
        link: titleEl ? titleEl.href : 'N/A',
        visualizacoes: viewsEl ? viewsEl.innerText.trim() : 'N/A',
        thumbnail: thumbnailEl ? thumbnailEl.src : 'N/A'
      };
    });
  }, maxVideos);

  await browser.close();
  return videos;
}

module.exports = { buscarVideos };
