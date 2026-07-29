const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LEN = 16;
const TAG_LEN = 16;

const BUILT_IN_SECRET = 'f4a9c7e2b1d83a6f5e0c9b4a7d2e1f8a3c6b9e4d7f0a2c5b8e1d4f7a0c3b6e9d2';

function getKey() {
  const raw = process.env.JWT_SECRET || BUILT_IN_SECRET;
  const hash = crypto.createHash('sha256').update(raw).digest();
  return hash;
}

function encrypt(text) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let enc = cipher.update(text, 'utf8', 'hex');
  enc += cipher.final('hex');
  const tag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + tag.toString('hex') + ':' + enc;
}

function decrypt(data) {
  if (!data) return '';
  const parts = data.split(':');
  if (parts.length !== 3) return '';
  const key = getKey();
  const iv = Buffer.from(parts[0], 'hex');
  const tag = Buffer.from(parts[1], 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  let dec = decipher.update(parts[2], 'hex', 'utf8');
  dec += decipher.final('utf8');
  return dec;
}

module.exports = { encrypt, decrypt };
