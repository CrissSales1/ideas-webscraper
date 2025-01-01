#!/bin/bash

# Iniciar o Redis em background
redis-server --daemonize yes

# Aguardar o Redis iniciar
sleep 2

# Iniciar a aplicação Node.js
npm start
