import { FastifyRequest, FastifyReply } from 'fastify';
import Article from '../models/Article';

class ArticleControllerError extends Error {
    statusCode: number;

    constructor(statusCode: number, message: string) {
        super(message);
        this.statusCode = statusCode;
    }
}

const normalizeText = (value: unknown) => (
    typeof value === 'string' ? value.trim() : ''
);

const slugifyTitle = (value: string) => value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

const stripHtmlTags = (value: string) => value.replace(/<[^>]+>/g, ' ');

const sanitizeArticleHtml = (value: unknown) => {
    if (typeof value !== 'string') {
        return '';
    }

    return value
        .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, '')
        .replace(/<(iframe|object|embed|form|input|button|textarea|select|meta|link|base)[^>]*>[\s\S]*?<\/\1>/gi, '')
        .replace(/<(iframe|object|embed|form|input|button|textarea|select|meta|link|base)([^>]*)\/?>/gi, '')
        .replace(/\s(on[a-z]+)\s*=\s*(["']).*?\2/gi, '')
        .replace(/\s(on[a-z]+)\s*=\s*[^\s>]+/gi, '')
        .replace(/\s(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '')
        .replace(/\s(href|src)\s*=\s*(["'])\s*data:text\/html[^"']*\2/gi, '')
        .replace(/\sstyle\s*=\s*(["']).*?\1/gi, '')
        .trim();
};

const validateStatus = (value: unknown, fallback: 'published' | 'draft' = 'draft') => {
    if (typeof value === 'undefined') {
        return fallback;
    }

    if (value !== 'published' && value !== 'draft') {
        throw new ArticleControllerError(400, 'Status artikel tidak valid');
    }

    return value;
};

const buildArticlePayload = (payload: any, current?: any) => {
    const title = normalizeText(payload?.title ?? current?.title);
    if (!title) {
        throw new ArticleControllerError(400, 'Judul artikel wajib diisi');
    }

    const slug = slugifyTitle(title);
    if (!slug) {
        throw new ArticleControllerError(400, 'Judul artikel tidak valid untuk dijadikan slug');
    }

    const excerpt = normalizeText(payload?.excerpt ?? current?.excerpt);
    if (!excerpt) {
        throw new ArticleControllerError(400, 'Ringkasan artikel wajib diisi');
    }

    const content = sanitizeArticleHtml(payload?.content ?? current?.content);
    if (!stripHtmlTags(content).trim()) {
        throw new ArticleControllerError(400, 'Konten artikel wajib diisi');
    }

    return {
        title,
        slug,
        excerpt,
        content,
        image: normalizeText(payload?.image ?? current?.image),
        category: normalizeText(payload?.category ?? current?.category) || 'Umum',
        status: validateStatus(payload?.status, current?.status || 'draft')
    };
};

const serializePublicArticle = (article: any) => ({
    ...article,
    title: normalizeText(article.title),
    excerpt: normalizeText(article.excerpt),
    category: normalizeText(article.category) || 'Umum',
    image: normalizeText(article.image),
    content: sanitizeArticleHtml(article.content)
});

const handleArticleError = (reply: FastifyReply, error: unknown) => {
    console.error(error);

    if (error instanceof ArticleControllerError) {
        return reply.status(error.statusCode).send({ message: error.message });
    }

    if ((error as any)?.code === 11000 && (error as any)?.keyPattern?.slug) {
        return reply.status(409).send({ message: 'Slug artikel sudah digunakan' });
    }

    return reply.status(500).send({ message: 'Internal Server Error' });
};

export const getArticles = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const articles = await Article.find({ status: 'published' })
            .sort({ createdAt: -1 })
            .lean();

        return reply.send(articles.map(serializePublicArticle));
    } catch (error) {
        return handleArticleError(reply, error);
    }
};

export const getArticleBySlug = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { slug } = request.params as { slug: string };

        const article = await Article.findOne({ slug, status: 'published' }).lean();
        if (!article) {
            return reply.status(404).send({ message: 'Article not found' });
        }

        return reply.send(serializePublicArticle(article));
    } catch (error) {
        return handleArticleError(reply, error);
    }
};

export const createArticle = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const payload = buildArticlePayload(request.body as any);
        const existing = await Article.findOne({ slug: payload.slug }).select('_id');
        if (existing) {
            return reply.status(409).send({ message: 'Slug artikel sudah digunakan' });
        }

        const article = await Article.create({
            ...payload,
            image: payload.image || undefined
        });

        return reply.status(201).send(article);
    } catch (error) {
        return handleArticleError(reply, error);
    }
};

export const updateArticle = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };

        const article = await Article.findById(id);
        if (!article) {
            return reply.status(404).send({ message: 'Article not found' });
        }

        const payload = buildArticlePayload(request.body as any, article);
        const existing = await Article.findOne({
            slug: payload.slug,
            _id: { $ne: article._id }
        }).select('_id');

        if (existing) {
            return reply.status(409).send({ message: 'Slug artikel sudah digunakan' });
        }

        article.title = payload.title;
        article.slug = payload.slug;
        article.excerpt = payload.excerpt;
        article.content = payload.content;
        article.image = payload.image || undefined;
        article.category = payload.category;
        article.status = payload.status;

        await article.save();
        return reply.send(article);
    } catch (error) {
        return handleArticleError(reply, error);
    }
};

export const deleteArticle = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };

        const article = await Article.findByIdAndDelete(id);
        if (!article) {
            return reply.status(404).send({ message: 'Article not found' });
        }

        return reply.send({ message: 'Article deleted' });
    } catch (error) {
        return handleArticleError(reply, error);
    }
};
