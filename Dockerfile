FROM node:18

# Instalar dependências do sistema necessárias para o Puppeteer, Chrome e Redis
RUN apt-get update && apt-get install -y \
    redis-server \
    wget \
    gnupg \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libgbm1 \
    libasound2 \
    libpangocairo-1.0-0 \
    libxss1 \
    libgtk-3-0 \
    libxshmfence1 \
    libglu1 \
    fonts-liberation \
    libappindicator3-1 \
    xdg-utils && \
    rm -rf /var/lib/apt/lists/*

# Baixar e instalar o Chrome
RUN wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - && \
    echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list && \
    apt-get update && apt-get install -y google-chrome-stable && \
    rm -rf /var/lib/apt/lists/*

# Configurar diretório de trabalho
WORKDIR /app

# Copiar arquivos do projeto
COPY package*.json ./
RUN npm install

COPY . .

# Expor porta
EXPOSE 3000

# Script de inicialização
COPY start.sh /start.sh
RUN chmod +x /start.sh

CMD ["/start.sh"]