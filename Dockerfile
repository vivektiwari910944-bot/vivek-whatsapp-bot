FROM node:20-slim

# Python + Node Dependencies setup
RUN apt-get update && apt-get install -y python3 python3-pip procps && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy Project Files
COPY package*.json ./
RUN npm install

COPY requirements.txt ./
RUN pip3 install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 5000 4000

# Start Engine & Flask UI together
CMD node index.js & python3 app.py
