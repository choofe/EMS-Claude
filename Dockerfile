# Dockerfile (در ریشه پروژه)

# ==========================================
# مرحله ۱: Build کردن فرانت‌اند (React)
# ==========================================
FROM node:22-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
ARG VITE_API_BASE_URL=/api
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN npm run build

# ==========================================
# مرحله ۲: آماده‌سازی بک‌اند (FastAPI)
# ==========================================
FROM python:3.12-slim AS backend-builder
WORKDIR /app/backend
COPY backend/requirements.txt ./
# استفاده از PyPI اصلی (مناسب برای سرورهای خارج از ایران)
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ ./

# ==========================================
# مرحله ۳: ایمیج نهایی (Nginx + FastAPI)
# ==========================================
FROM python:3.12-slim-bookworm

# نصب Nginx از مخزن رسمی Debian
RUN apt-get update && apt-get install -y nginx && rm -rf /var/lib/apt/lists/*

# کپی کردن بک‌اند از مرحله قبل
WORKDIR /app/backend
COPY --from=backend-builder /app/backend /app/backend
COPY --from=backend-builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=backend-builder /usr/local/bin /usr/local/bin

# کپی کردن فایل‌های Build شده React به پوشه Nginx
COPY --from=frontend-builder /app/frontend/dist /usr/share/nginx/html

# حذف فایل‌های پیش‌فرض Nginx برای جلوگیری از تداخل
RUN rm -f /etc/nginx/conf.d/default.conf && \
    rm -f /etc/nginx/sites-enabled/default

# کپی کردن تنظیمات Nginx و اسکریپت Entrypoint
COPY deploy/nginx.conf /etc/nginx/conf.d/ems.conf
COPY deploy/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# پورت ۸۰ (Nginx)
EXPOSE 80

# اجرای اسکریپت Entrypoint
ENTRYPOINT ["/app/entrypoint.sh"]