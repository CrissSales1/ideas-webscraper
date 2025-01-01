const express = require('express');
const { buscarVideos } = require('./youtubeScraper');
const { buscarDadosInstagram } = require('./instagramScraper');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.post('/youtube', async (req, res) => {
  const { keyword, maxVideos, minDuration, maxDuration, dateFilter } = req.body;

  if (!keyword) {
    return res.status(400).json({ error: 'Palavra-chave (keyword) é obrigatória.' });
  }

  try {
    const result = await buscarVideos(keyword, maxVideos || 10, {
      minDuration,
      maxDuration,
      dateFilter
    });

    if (!result.success) {
      return res.status(500).json({
        error: 'Erro ao realizar a busca no YouTube.',
        details: result.error
      });
    }

    res.json({
      message: 'Busca concluída com sucesso!',
      total: result.total,
      query: result.query,
      videos: result.data
    });
  } catch (err) {
    console.error('Erro durante a raspagem do YouTube:', err);
    res.status(500).json({
      error: 'Erro ao realizar a busca no YouTube.',
      details: err.message
    });
  }
});

app.post('/instagram', async (req, res) => {
  const { hashtag, maxPosts } = req.body;

  if (!hashtag) {
    return res.status(400).json({ error: 'Hashtag é obrigatória.' });
  }

  try {
    const posts = await buscarDadosInstagram(hashtag, maxPosts || 10);
    res.json({ message: 'Busca concluída com sucesso!', posts });
  } catch (err) {
    console.error('Erro durante a raspagem do Instagram:', err);
    res.status(500).json({ error: 'Erro ao realizar a busca no Instagram.' });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
