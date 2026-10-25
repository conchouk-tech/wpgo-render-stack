FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server-v2.js ./
ENV NODE_ENV=production PORT=8090
EXPOSE 8090
CMD ["npm","start"]
