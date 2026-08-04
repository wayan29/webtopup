import { Settings, Transaction } from '../models';

const getSettingValue = async (key: string, defaultValue: any): Promise<any> => {
    const setting = await Settings.findOne({ key }).lean();
    return setting ? setting.value : defaultValue;
};

const formatDatePart = (dateFormat: string): string => {
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yyyy = String(now.getFullYear());
    const yy = yyyy.slice(2);

    switch (dateFormat) {
        case 'DDMMYYYY': return `${dd}${mm}${yyyy}`;
        case 'YYYYMMDD': return `${yyyy}${mm}${dd}`;
        case 'MMDDYYYY': return `${mm}${dd}${yyyy}`;
        case 'DDMMYY': return `${dd}${mm}${yy}`;
        case 'YYMMDD': return `${yy}${mm}${dd}`;
        case 'NONE': return '';
        default: return `${dd}${mm}${yyyy}`;
    }
};

export const generateRefId = async (): Promise<string> => {
    const [prefix, dateFormat, separator, seqDigits] = await Promise.all([
        getSettingValue('refIdPrefix', 'REF'),
        getSettingValue('refIdDateFormat', 'DDMMYYYY'),
        getSettingValue('refIdSeparator', ''),
        getSettingValue('refIdSequenceDigits', 4),
    ]);

    const datePart = formatDatePart(dateFormat);

    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const todayCount = await Transaction.countDocuments({
        createdAt: { $gte: startOfDay, $lte: endOfDay }
    });

    const digits = Math.max(1, Math.min(10, seqDigits));
    const sequence = String(todayCount + 1).padStart(digits, '0');

    const parts = [prefix, datePart, sequence].filter(Boolean);
    return parts.join(separator);
};

export const generateInvoiceNumber = async (): Promise<string> => {
    const [prefix, dateFormat, separator, randomLength, randomType] = await Promise.all([
        getSettingValue('invoicePrefix', 'INV'),
        getSettingValue('invoiceDateFormat', 'YYYYMMDD'),
        getSettingValue('invoiceSeparator', ''),
        getSettingValue('invoiceRandomLength', 6),
        getSettingValue('invoiceRandomType', 'alphanumeric'),
    ]);

    const datePart = formatDatePart(dateFormat);

    const len = Math.max(1, Math.min(12, randomLength));
    let random = '';
    if (randomType === 'numeric') {
        random = Array.from({ length: len }, () => Math.floor(Math.random() * 10)).join('');
    } else {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        random = Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    }

    const parts = [prefix, datePart, random].filter(Boolean);
    return parts.join(separator);
};
