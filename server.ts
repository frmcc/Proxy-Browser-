import express from 'express';
import { createServer as createViteServer } from 'vite';
import * as cheerio from 'cheerio';
import path from 'path';

const cookieStore = new Map<string, Map<string, string>>();

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.set('trust proxy', true);
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  app.all('/api/proxy', async (req, res) => {
    const targetUrlString = req.query.url as string;
    if (!targetUrlString) return res.status(400).send('URL required');

    try {
      const targetUrl = new URL(targetUrlString);

      // Forward query params
      for (const [key, value] of Object.entries(req.query)) {
        if (key !== 'url') {
          targetUrl.searchParams.append(key, value as string);
        }
      }

      const headers = new Headers();
      headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      headers.set('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
      headers.set('Accept-Language', 'en-US,en;q=0.5');

      const targetDomain = targetUrl.hostname;
      const domainCookies = cookieStore.get(targetDomain) || new Map<string, string>();
      if (domainCookies.size > 0) {
        const cookieString = Array.from(domainCookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
        headers.set('Cookie', cookieString);
      }

      const fetchOptions: RequestInit = {
        method: req.method,
        headers,
        redirect: 'manual',
      };

      if (req.method !== 'GET' && req.method !== 'HEAD') {
         if (req.body && Object.keys(req.body).length > 0) {
             if (req.headers['content-type']?.includes('application/json')) {
                 fetchOptions.body = JSON.stringify(req.body);
                 headers.set('Content-Type', 'application/json');
             } else if (req.headers['content-type']?.includes('application/x-www-form-urlencoded')) {
                 fetchOptions.body = new URLSearchParams(req.body).toString();
                 headers.set('Content-Type', 'application/x-www-form-urlencoded');
             }
         }
      }

      const response = await fetch(targetUrl.toString(), fetchOptions);

      const setCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
      if (setCookies.length > 0) {
        setCookies.forEach(cookieStr => {
          const parts = cookieStr.split(';');
          const nameValue = parts[0].trim();
          const splitIdx = nameValue.indexOf('=');
          if (splitIdx !== -1) {
            const name = nameValue.substring(0, splitIdx);
            const value = nameValue.substring(splitIdx + 1);
            domainCookies.set(name, value);
          }
        });
        cookieStore.set(targetDomain, domainCookies);
      }

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (location) {
          const absoluteLocation = new URL(location, targetUrl.toString()).toString();
          return res.redirect(`/api/proxy?url=${encodeURIComponent(absoluteLocation)}`);
        }
      }

      const contentType = response.headers.get('content-type') || '';

      if (contentType.startsWith('image/') || contentType.startsWith('video/') || contentType.startsWith('audio/')) {
        return res.status(403).send('Media blocked');
      }
      const disposition = response.headers.get('content-disposition');
      if (disposition && disposition.includes('attachment')) {
        return res.status(403).send('Downloads blocked');
      }

      const buffer = await response.arrayBuffer();

      response.headers.forEach((value, key) => {
        const lowerKey = key.toLowerCase();
        if (!['content-encoding', 'content-length', 'transfer-encoding', 'x-frame-options', 'content-security-policy', 'access-control-allow-origin'].includes(lowerKey)) {
          res.setHeader(key, value);
        }
      });

      res.setHeader('Content-Security-Policy', "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; img-src 'none'; media-src 'none'; object-src 'none'; frame-ancestors *;");
      res.setHeader('X-Frame-Options', 'ALLOWALL');
      res.setHeader('Access-Control-Allow-Origin', '*');

      if (contentType.includes('text/html')) {
        const html = Buffer.from(buffer).toString('utf-8');
        const $ = cheerio.load(html);

        $('img, video, audio, picture, source, canvas, svg').remove();

        const appUrl = req.protocol + '://' + req.get('host');

        const rewriteUrl = (url: string | undefined) => {
          if (!url || url.startsWith('javascript:') || url.startsWith('mailto:') || url.startsWith('#') || url.startsWith('data:')) return url;
          try {
            const absoluteUrl = new URL(url, targetUrl.toString()).toString();
            return `${appUrl}/api/proxy?url=${encodeURIComponent(absoluteUrl)}`;
          } catch (e) {
            return url;
          }
        };

        $('a').each((i, el) => {
          const href = $(el).attr('href');
          if (href) $(el).attr('href', rewriteUrl(href));
        });

        $('script').each((i, el) => {
          const src = $(el).attr('src');
          if (src) $(el).attr('src', rewriteUrl(src));
        });

        $('link').each((i, el) => {
          const href = $(el).attr('href');
          if (href) $(el).attr('href', rewriteUrl(href));
        });

        $('iframe').each((i, el) => {
          const src = $(el).attr('src');
          if (src) $(el).attr('src', rewriteUrl(src));
        });

        $('form').each((i, el) => {
          const action = $(el).attr('action') || targetUrl.toString();
          try {
            const absoluteUrl = new URL(action, targetUrl.toString()).toString();
            $(el).attr('action', `${appUrl}/api/proxy`);
            $(el).prepend(`<input type="hidden" name="url" value="${absoluteUrl}">`);
          } catch (e) {}
        });

        $('head').append(`
          <style>
            * { background-image: none !important; }
            img, video, audio, picture, svg, canvas { display: none !important; }
            html { margin-top: 48px !important; }
          </style>
        `);

        const toolbarHtml = `
          <div id="focus-toolbar" style="all: initial; position: fixed; top: 0; left: 0; width: 100%; height: 48px; background: #f3f4f6; z-index: 2147483647; display: flex; align-items: center; padding: 0 8px; border-bottom: 1px solid #d1d5db; font-family: system-ui, sans-serif; box-sizing: border-box;">
            <button onclick="window.history.back()" style="all: initial; cursor: pointer; padding: 4px 8px; margin-right: 4px; background: #fff; border: 1px solid #d1d5db; border-radius: 4px; font-size: 14px; color: #374151; display: flex; align-items: center; justify-content: center;">&larr;</button>
            <button onclick="window.history.forward()" style="all: initial; cursor: pointer; padding: 4px 8px; margin-right: 4px; background: #fff; border: 1px solid #d1d5db; border-radius: 4px; font-size: 14px; color: #374151; display: flex; align-items: center; justify-content: center;">&rarr;</button>
            <button onclick="window.location.reload()" style="all: initial; cursor: pointer; padding: 4px 8px; margin-right: 8px; background: #fff; border: 1px solid #d1d5db; border-radius: 4px; font-size: 14px; color: #374151; display: flex; align-items: center; justify-content: center;">&#x21bb;</button>
            <button onclick="window.location.href='/'" style="all: initial; cursor: pointer; padding: 4px 8px; margin-right: 8px; background: #fff; border: 1px solid #d1d5db; border-radius: 4px; font-size: 14px; color: #374151; display: flex; align-items: center; justify-content: center;">Home</button>
            <form onsubmit="event.preventDefault(); let u = document.getElementById('focus-input').value; if(!u.startsWith('http') && u.includes('.')) u = 'https://' + u; else if (!u.startsWith('http')) u = 'https://www.google.com/search?q=' + encodeURIComponent(u); window.location.href='/api/proxy?url=' + encodeURIComponent(u);" style="all: initial; display: flex; flex: 1;">
              <input id="focus-input" type="text" value="${targetUrl.toString()}" style="all: initial; flex: 1; background: #fff; border: 1px solid #d1d5db; border-radius: 4px; padding: 4px 8px; font-size: 14px; box-sizing: border-box; color: #374151;" />
            </form>
          </div>
        `;
        $('body').prepend(toolbarHtml);

        res.setHeader('Content-Type', contentType);
        res.send($.html());
      } else {
        res.setHeader('Content-Type', contentType);
        res.send(Buffer.from(buffer));
      }

    } catch (error: any) {
      console.error('Proxy error:', error);
      res.status(500).send(`
        <html>
          <body style="font-family: sans-serif; padding: 2rem; text-align: center;">
            <h2>Failed to load page</h2>
            <p style="color: #666;">${error.message}</p>
            <button onclick="window.history.back()" style="padding: 8px 16px; margin-top: 16px; cursor: pointer;">Go Back</button>
          </body>
        </html>
      `);
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
