import { FastifyRequest } from 'fastify';
import net from 'net';

type Ipv4Range = {
    base: number;
    mask: number;
};

const CLOUDFLARE_IPV4_CIDRS = [
    '173.245.48.0/20',
    '103.21.244.0/22',
    '103.22.200.0/22',
    '103.31.4.0/22',
    '141.101.64.0/18',
    '108.162.192.0/18',
    '190.93.240.0/20',
    '188.114.96.0/20',
    '197.234.240.0/22',
    '198.41.128.0/17',
    '162.158.0.0/15',
    '104.16.0.0/13',
    '104.24.0.0/14',
    '172.64.0.0/13',
    '131.0.72.0/22'
];

const CLOUDFLARE_IPV6_PREFIXES = [
    '2400:cb00:',
    '2606:4700:',
    '2803:f800:',
    '2405:b500:',
    '2405:8100:',
    '2a06:98c0:',
    '2c0f:f248:'
];

export const normalizeIpAddress = (value: unknown) => (
    typeof value === 'string'
        ? value.replace(/^::ffff:/, '').trim()
        : ''
);

const ipv4ToNumber = (ip: string) => {
    const parts = ip.split('.').map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
        return null;
    }

    return parts.reduce((total, part) => ((total << 8) + part) >>> 0, 0);
};

const parseIpv4Cidr = (cidr: string): Ipv4Range | null => {
    const [ip, prefixValue] = cidr.split('/');
    const baseIp = ipv4ToNumber(ip);
    const prefix = Number(prefixValue);

    if (baseIp === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
        return null;
    }

    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return {
        base: baseIp & mask,
        mask
    };
};

const CLOUDFLARE_IPV4_RANGES = CLOUDFLARE_IPV4_CIDRS
    .map(parseIpv4Cidr)
    .filter((range): range is Ipv4Range => Boolean(range));

const isCloudflareProxyIp = (value: string) => {
    const ip = normalizeIpAddress(value).toLowerCase();
    const ipVersion = net.isIP(ip);

    if (ipVersion === 4) {
        const numericIp = ipv4ToNumber(ip);
        return numericIp !== null && CLOUDFLARE_IPV4_RANGES.some((range) => (
            (numericIp & range.mask) === range.base
        ));
    }

    if (ipVersion === 6) {
        return CLOUDFLARE_IPV6_PREFIXES.some((prefix) => ip.startsWith(prefix));
    }

    return false;
};

export const isTrustedProxyHop = (value: string) => {
    const ip = normalizeIpAddress(value);
    return ip === '127.0.0.1'
        || ip === '::1'
        || ip.startsWith('10.')
        || ip.startsWith('192.168.')
        || /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)
        || isCloudflareProxyIp(ip);
};

const getHeaderIp = (value: string | string[] | undefined) => {
    if (!value) {
        return '';
    }

    const raw = Array.isArray(value) ? value[0] : value;
    const candidate = normalizeIpAddress(raw.split(',')[0].trim());
    return net.isIP(candidate) ? candidate : '';
};

export const getRequestClientIp = (request: FastifyRequest) => {
    const socketIp = normalizeIpAddress(String(request.ip || request.raw.socket.remoteAddress || ''));
    if (!socketIp) {
        return '';
    }

    if (!isTrustedProxyHop(socketIp)) {
        return socketIp;
    }

    return getHeaderIp(request.headers['cf-connecting-ip'])
        || getHeaderIp(request.headers['x-forwarded-for'])
        || getHeaderIp(request.headers['x-real-ip'])
        || socketIp;
};
