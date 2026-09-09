import { describe, expect, it } from 'vitest';
import { assertPublicUrl, BlockedTargetError, resolvesPublicly } from '../src/utils/ssrf';

/**
 * DNS-free assertions only: literal IPs never touch the resolver, and
 * "localhost" resolves via the hosts file — the suite must pass offline.
 */
describe('assertPublicUrl', () => {
  it('accepts literal public IPs', async () => {
    await expect(assertPublicUrl('https://8.8.8.8/')).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl('http://93.184.216.34/path')).resolves.toBeInstanceOf(URL);
  });

  it('rejects loopback', async () => {
    await expect(assertPublicUrl('http://127.0.0.1:6379/')).rejects.toBeInstanceOf(BlockedTargetError);
    await expect(assertPublicUrl('http://[::1]/')).rejects.toBeInstanceOf(BlockedTargetError);
  });

  it('rejects private ranges', async () => {
    await expect(assertPublicUrl('http://10.0.0.5/admin')).rejects.toBeInstanceOf(BlockedTargetError);
    await expect(assertPublicUrl('http://192.168.1.1/')).rejects.toBeInstanceOf(BlockedTargetError);
    await expect(assertPublicUrl('http://172.16.0.10/')).rejects.toBeInstanceOf(BlockedTargetError);
  });

  it('rejects link-local (cloud metadata endpoint)', async () => {
    await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data/')).rejects.toBeInstanceOf(
      BlockedTargetError,
    );
  });

  it('rejects carrier-grade NAT and unspecified addresses', async () => {
    await expect(assertPublicUrl('http://100.64.0.1/')).rejects.toBeInstanceOf(BlockedTargetError);
    await expect(assertPublicUrl('http://0.0.0.0/')).rejects.toBeInstanceOf(BlockedTargetError);
  });

  it('rejects localhost by name (resolves to loopback via hosts file)', async () => {
    await expect(assertPublicUrl('http://localhost:4000/api')).rejects.toBeInstanceOf(
      BlockedTargetError,
    );
  });

  it('rejects non-HTTP protocols', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toBeInstanceOf(BlockedTargetError);
    await expect(assertPublicUrl('ftp://8.8.8.8/pub')).rejects.toBeInstanceOf(BlockedTargetError);
    await expect(assertPublicUrl('gopher://127.0.0.1/')).rejects.toBeInstanceOf(BlockedTargetError);
  });

  it('fails closed on unresolvable hostnames', async () => {
    await expect(resolvesPublicly('nonexistent.invalid')).resolves.toBe(false);
  });
});
