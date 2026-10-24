FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npx playwright install --with-deps chromium
COPY server.js ./
EXPOSE 8080
CMD ["npm", "start"]
