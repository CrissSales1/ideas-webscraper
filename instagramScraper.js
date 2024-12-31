const puppeteer = require('puppeteer');
const os = require('os');

async function buscarDadosInstagram(hashtag, maxPosts = 10) {
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

  const url = `https://www.instagram.com/explore/tags/${encodeURIComponent(hashtag)}/`;
  await page.goto(url, { waitUntil: 'networkidle2' });

  await page.waitForSelector('article div div div div a');

  const posts = await page.evaluate((maxPosts) => {
    const postElements = Array.from(document.querySelectorAll('article div div div div a')).slice(0, maxPosts);

    return postElements.map((el) => {
      const link = el.href;
      const imageElement = el.querySelector('img');
      const image = imageElement ? imageElement.src : null;

      return { link, image };
    });
  }, maxPosts);

  for (const post of posts) {
    await page.goto(post.link, { waitUntil: 'networkidle2' });

    const metrics = await page.evaluate(() => {
      const likesElement = document.querySelector('div span[aria-label="likes"]');
      const commentsElement = document.querySelector('ul li span');

      const likes = likesElement ? likesElement.innerText : 'N/A';
      const comments = commentsElement ? commentsElement.innerText : 'N/A';

      return { likes, comments };
    });

    post.likes = metrics.likes;
    post.comments = metrics.comments;
  }

  await browser.close();
  return posts;
}

module.exports = { buscarDadosInstagram };
