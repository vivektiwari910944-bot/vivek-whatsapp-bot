FROM node:20-bullseye-slim

# System dependencies install karo
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Clean NPM install setup
RUN npm cache clean --force && npm install --production

# Python requirements install karo
COPY requirements.txt ./
RUN pip3 install --no-cache-dir -r requirements.txt

# Baaki saari files copy karo
COPY . .

EXPOSE 5000 4000

# Engine aur Flask UI ek sath start karne ke liye
CMD node index.js & python3 app.py
