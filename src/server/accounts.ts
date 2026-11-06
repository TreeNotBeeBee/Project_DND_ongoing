import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { ApiError } from './security';

// Node 26's native Argon2id. Store parameters with the hash so later upgrades can rehash on login.
const parameters = { memory: 65536, passes: 3, parallelism: 1, tagLength: 32 };
function derive(password: string, nonce: Buffer) {
  return new Promise<Buffer>((resolve, reject) => argon2('argon2id', { ...parameters, message: password, nonce }, (error, key) => error ? reject(error) : resolve(key)));
}
export function accountInput(body: Record<string, unknown>) {
  const username = typeof body.username === 'string' ? body.username.normalize('NFKC').trim() : '';
  if (username.length < 3 || username.length > 48 || !/^[\p{L}\p{N}._-]+$/u.test(username)) throw new ApiError(400, 'username_format', '账号须为3至48个字，使用汉字、字母、数字或 . _ -');
  const password = body.password;
  if (typeof password !== 'string' || password.length < 8 || password.length > 128 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(password)) throw new ApiError(400, 'password_format', '密码须为8至128个字符，不能包含控制字符');
  let displayName = username;
  if (body.displayName !== undefined) {
    if (typeof body.displayName !== 'string' || !body.displayName.trim() || body.displayName.trim().length > 80 || /[\u0000-\u001f\u007f]/u.test(body.displayName)) throw new ApiError(400, 'display_name_format', '称呼须为1至80个字，不能包含控制字符');
    displayName = body.displayName.trim();
  }
  return { username, usernameKey: username.toLowerCase(), password, displayName };
}
export async function passwordHash(password: string) {
  const salt = randomBytes(16), key = await derive(password, salt);
  return ['argon2id', 'v=19', `m=${parameters.memory},t=${parameters.passes},p=${parameters.parallelism}`, salt.toString('base64url'), key.toString('base64url')].join('$');
}
export async function verifyPassword(password: string, encoded: string) {
  const [algorithm, version, params, saltText, keyText, extra] = encoded.split('$');
  if (algorithm !== 'argon2id' || version !== 'v=19' || params !== 'm=65536,t=3,p=1' || extra !== undefined || !/^[A-Za-z0-9_-]{22}$/.test(saltText || '') || !/^[A-Za-z0-9_-]{43}$/.test(keyText || '')) return false;
  const key = await derive(password, Buffer.from(saltText, 'base64url'));
  return timingSafeEqual(key, Buffer.from(keyText, 'base64url'));
}
