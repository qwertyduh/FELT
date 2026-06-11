FROM node:22-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

EXPOSE 5173

# Vite requires '--host' to allow external connections from the container to localhost
CMD ["npm", "run", "dev", "--", "--host"]