import 'dotenv/config';

import { createBlobService } from 'azure-storage';
import { createServer } from 'restify';
import { getType } from 'mime';
import { extname, join, posix } from 'path';
import { promisify } from 'util';
import { URL } from 'url';

import createZipFileObservable from './ZipFileObservable';
import random from 'math-random';

const { AZURE_STORAGE_ACCOUNT, AZURE_STORAGE_CONTAINER, PORT = 5000 } = process.env;
const { join: posixJoin } = posix;
const MAX_UPLOAD_SIZE = 104857600; // 100 MB

function pad(value, count = 2, padding = '0') {
  value += '';
  count -= value.length;

  while (count-- > 0) {
    value = padding + value;
  }

  return value;
}

(async function () {
  const blobService = createBlobService();
  const createBlockBlobFromLocalFile = promisify(blobService.createBlockBlobFromLocalFile.bind(blobService));
  const createBlockBlobFromStream = promisify(blobService.createBlockBlobFromStream.bind(blobService));
  const createBlockBlobFromText = promisify(blobService.createBlockBlobFromText.bind(blobService));
  const server = createServer();

  server.get('/health.txt', (_, res) => {
    res.json({ now: Date.now() });
  });

  server.get('/ready.txt', (_, res) => {
    res.json({ now: Date.now() });
  });

  server.put('/upload', (req, res) => {
    const buffers = [];
    let numBytes = 0;

    req.on('data', data => {
      buffers.push(data);
      numBytes += data.length;

      if (numBytes >= MAX_UPLOAD_SIZE) {
        res.send(500, { message: 'too large' });
      }
    });

    req.on('end', async () => {
      try {
        const now = new Date();
        const id = [
          now.getUTCFullYear(),
          pad(now.getUTCMonth() + 1),
          pad(now.getUTCDate()),
          random().toString(36).substr(2, 5)
        ].join('/');
        const buffer = Buffer.concat(buffers, numBytes);
        const zipFileObservable = createZipFileObservable(buffer);
        const filesUploaded = [];

        const baseURL = new URL(`https://${ AZURE_STORAGE_ACCOUNT }.blob.core.windows.net/${ AZURE_STORAGE_CONTAINER }/${ id }/`);

        zipFileObservable.subscribe({
          complete: async () => {
            await createBlockBlobFromLocalFile(AZURE_STORAGE_CONTAINER, posixJoin(id, 'index.html'), join(__dirname, '../public/index.html'));
            await createBlockBlobFromText(AZURE_STORAGE_CONTAINER, posixJoin(id, 'index.json'), JSON.stringify({ files: filesUploaded }));

            res.sendRaw(
              200,
              JSON.stringify({
                id,
                human: `Your artifacts is now uploaded, you can look at list of them at ${ baseURL.toString() }index.html.`
              }, null, 2),
              { 'Content-Type': 'application/json' }
            );
          },
          error: err => {
            console.error(err);

            res.send(500);
          },
          next: async ({ entry, next, readStream }) => {
            console.log(`Uploading ${ entry.fileName }`);

            const contentType = getType(extname(entry.fileName));

            await createBlockBlobFromStream(
              AZURE_STORAGE_CONTAINER,
              posixJoin(id, entry.fileName),
              readStream,
              entry.uncompressedSize,
              {
                contentSettings: { contentType }
              }
            );
            filesUploaded.push(entry.fileName);

            next();
          }
        });
      } catch (err) {
        res.send(500, { message: err.message });
      }
    });
  });

  server.listen(PORT, () => {
    console.log(`Listening to port ${ PORT }`);
  });
})();
