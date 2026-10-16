import { createApp } from './app.js';

const port = Number(process.env.PORT || 8000);
createApp().listen(port, '127.0.0.1', () => console.log(`nanit-mcp listening on http://127.0.0.1:${port}`));
