FROM mcr.microsoft.com/playwright:v1.64.0-noble
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server-v3.js ./server-v3.js
ENV NODE_ENV=production
EXPOSE 8080
CMD ["npm", "start"]
