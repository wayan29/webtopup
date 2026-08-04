type CategoryLike =
    | {
        name?: string;
        slug?: string;
        status?: string;
    }
    | string
    | null
    | undefined;

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const isValidTimeString = (value: string) => TIME_PATTERN.test(value);

export const timeToMinutes = (value: string) => {
    const match = value.match(TIME_PATTERN);
    if (!match) return NaN;

    return Number(match[1]) * 60 + Number(match[2]);
};

export const isOperationalNow = (
    operationalStart: string,
    operationalEnd: string,
    now = new Date()
) => {
    const startMinutes = timeToMinutes(operationalStart);
    const endMinutes = timeToMinutes(operationalEnd);

    if (!Number.isFinite(startMinutes) || !Number.isFinite(endMinutes)) {
        return false;
    }

    if (startMinutes === endMinutes) {
        return true;
    }

    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    if (startMinutes < endMinutes) {
        return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
    }

    return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
};

export const getCategoryName = (category: CategoryLike) => {
    if (!category) return '';
    if (typeof category === 'string') return category;
    return category.name ?? '';
};

export const getCategorySlug = (category: CategoryLike) => {
    if (!category) return '';
    if (typeof category === 'string') {
        return category.toLowerCase().replace(/\s+/g, '-');
    }

    if (category.slug) return category.slug;
    return (category.name ?? '').toLowerCase().replace(/\s+/g, '-');
};

export const isCategoryActive = (category: CategoryLike) => {
    if (!category || typeof category === 'string') return false;
    return category.status === 'active';
};

export const isBankTransferCategory = (category: CategoryLike) => {
    const name = getCategoryName(category).toLowerCase();
    const slug = getCategorySlug(category).toLowerCase();

    return (
        name.includes('bank') ||
        name.includes('transfer') ||
        slug.includes('bank') ||
        slug.includes('transfer')
    );
};
