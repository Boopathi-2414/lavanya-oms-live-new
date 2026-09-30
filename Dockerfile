FROM nginx:stable-alpine
COPY lavanya-oms-site.zip /tmp/site.zip
RUN rm -rf /usr/share/nginx/html/* && cd /usr/share/nginx/html && unzip -q /tmp/site.zip && rm /tmp/site.zip
RUN printf 'server {\n listen 80;\n root /usr/share/nginx/html;\n index index.html;\n server_tokens off;\n gzip on;\n gzip_types text/css application/javascript application/json image/svg+xml;\n location /assets/ { expires 1y; add_header Cache-Control "public, immutable"; }\n location / { add_header Cache-Control "no-store"; add_header X-Frame-Options DENY; add_header X-Content-Type-Options nosniff; try_files $uri $uri/ /index.html; }\n}\n' > /etc/nginx/conf.d/default.conf
EXPOSE 80
