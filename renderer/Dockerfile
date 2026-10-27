FROM mcr.microsoft.com/playwright:v1.64.0-noble
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js ./server.js
ENV NODE_ENV=production
EXPOSE 8080
CMD ["npm", "start"]
