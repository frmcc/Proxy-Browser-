import http from 'node:http';

/**
 * A minimal origin server for tests, so nothing here depends on the network.
 * Start it, point the code under test at its address, stop it.
 */
export function startFixture() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    switch (url.pathname) {
      case '/':
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<!doctype html><html><head>
<link rel="icon" href="/favicon.ico">
<style>body{background:url(bg.png)} @font-face{src:url("f.woff2")}</style>
</head><body>
<img src="photo.jpg" alt="a">
<video src="clip.mp4"></video>
<picture><source srcset="x.webp"><img src="y.jpg"></picture>
<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>
<a href="/page">relative</a>
<a href="//example.net/other">protocol relative</a>
<a href="#top">fragment</a>
<a href="mailto:a@b.c">mail</a>
<form method="get" action="/search"><input name="q"></form>
<form method="post" action="/login"><input name="user"></form>
<noscript><img src="pixel.gif"></noscript>
</body></html>`);

      case '/image.png':
        res.writeHead(200, { 'Content-Type': 'image/png' });
        return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      case '/clip.mp4':
        res.writeHead(200, { 'Content-Type': 'video/mp4' });
        return res.end('not really a video');

      case '/download':
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment; filename="report.pdf"',
        });
        return res.end('binary');

      case '/redirect':
        res.writeHead(302, { Location: '/' });
        return res.end();

      case '/redirect-private':
        res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
        return res.end();

      case '/style.css':
        res.writeHead(200, { 'Content-Type': 'text/css' });
        return res.end('@import "base.css"; body { background: url(hero.jpg); } @font-face { src: url("f.woff2"); }');

      case '/setcookie':
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Set-Cookie': 'sid=abc123; Path=/',
        });
        return res.end('<html><body>ok</body></html>');

      case '/latin1':
        res.writeHead(200, { 'Content-Type': 'text/html; charset=iso-8859-1' });
        return res.end(Buffer.from('<html><body><p>caf\xe9 na\xefve</p></body></html>', 'latin1'));

      case '/echo': {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        return req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ method: req.method, headers: req.headers, body }));
        });
      }

      default:
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('not found');
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        origin: `http://127.0.0.1:${port}`,
        url: (pathname) => new URL(pathname, `http://127.0.0.1:${port}`),
        stop: () => new Promise((done) => server.close(done)),
      });
    });
  });
}
