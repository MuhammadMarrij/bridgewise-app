// Prints the Alipay app private key on one line with literal \n, ready to paste
// into Vercel's ALIPAY_PRIVATE_KEY environment variable. Never paste it into chat.
import { readFileSync } from 'node:fs';
process.stdout.write(readFileSync('secrets/alipay_app_private.pem', 'utf8').trim().split(/\r?\n/).join('\n') + '\n');
