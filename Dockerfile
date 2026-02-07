# Use a lightweight Node.js image
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Expose port (App Runner typically uses 8080 by default, but we can configure it)
EXPOSE 8080

# Environment variable for port
ENV PORT=8080
ENV NODE_ENV=production

# Start the application
CMD ["npm", "start"]
