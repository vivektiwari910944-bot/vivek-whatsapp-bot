FROM node:20-alpine

# Python & System dependencies install
RUN apk add --no-舆-cache python3 py3-pip procps

WORKDIR /app

# Copy dependency files
COPY package*.json ./
COPY requirements.txt ./

# Fast and clean package installation
RUN npm install --omit=dev
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

# Copy source files
COPY . .

EXPOSE 5000 4000

# Start Engine and Flask Server
CMD node index.js & python3 app.py
