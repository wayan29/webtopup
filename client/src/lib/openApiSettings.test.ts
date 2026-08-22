import assert from 'node:assert/strict';
import test from 'node:test';
import {
    SETTINGS_TABS,
    parseSettingsTab,
    openApiSecretStatus,
    canCopyOpenApiSecret,
    maskOpenApiKey,
    buildOpenApiBaseUrl,
    OPEN_API_LIST_SIGNATURE,
    OPEN_API_ORDER_SIGNATURE,
    OPEN_API_ENDPOINTS,
    openApiCurlExamples,
} from './openApiSettings.ts';

test('settings tabs fail closed and keep a stable order', () => {
    assert.deepEqual(SETTINGS_TABS, ['preferences', 'api', 'security']);
    assert.equal(parseSettingsTab('api'), 'api');
    assert.equal(parseSettingsTab('security'), 'security');
    assert.equal(parseSettingsTab('preferences'), 'preferences');
    assert.equal(parseSettingsTab(null), 'preferences');
    assert.equal(parseSettingsTab('unknown'), 'preferences');
    assert.equal(parseSettingsTab(['api']), 'preferences');
});

test('secret status allows copy only while plaintext is in memory', () => {
    assert.equal(openApiSecretStatus({ plaintext: 'once-only', hasStoredSecret: true }), 'visible');
    assert.equal(openApiSecretStatus({ plaintext: null, hasStoredSecret: true }), 'stored-hidden');
    assert.equal(openApiSecretStatus({ plaintext: '', hasStoredSecret: false }), 'missing');
    assert.equal(canCopyOpenApiSecret('visible'), true);
    assert.equal(canCopyOpenApiSecret('stored-hidden'), false);
    assert.equal(canCopyOpenApiSecret('missing'), false);
});

test('api key masking keeps prefix/suffix without exposing short keys in full', () => {
    assert.equal(maskOpenApiKey(null), '');
    assert.equal(maskOpenApiKey(''), '');
    assert.equal(maskOpenApiKey('shortkey'), 'sh****ey');
    assert.equal(
        maskOpenApiKey('tv_live_abcdefghijklmnop'),
        `tv_live_${'*'.repeat(8)}ijklmnop`,
    );
});

test('open api base url joins relative and absolute v2 roots onto /api', () => {
    assert.equal(
        buildOpenApiBaseUrl('/api/v2', 'https://danayasa.biz.id'),
        'https://danayasa.biz.id/api/v2/api',
    );
    assert.equal(
        buildOpenApiBaseUrl('https://api.example.test/api/v2/', 'https://ignored.example'),
        'https://api.example.test/api/v2/api',
    );
});

test('docs catalog and curl examples stay placeholder-only', () => {
    assert.equal(OPEN_API_LIST_SIGNATURE, 'md5(member_id:api_key:secret)');
    assert.equal(OPEN_API_ORDER_SIGNATURE, 'md5(member_id:api_key:secret:ref_id)');
    assert.deepEqual(
        OPEN_API_ENDPOINTS.map((item) => `${item.method} ${item.path}`),
        [
            'GET /profile',
            'GET /categories',
            'GET /operators?category=category_id',
            'GET /product-types?category=category_id&operator=operator_id',
            'GET /products?category=category_id&operator=operator_id&type=type_id',
            'POST /order',
            'POST /transaction',
            'GET /transaction/check?ref_id=xxx&member_id=xxx&api_key=xxx&signature=xxx',
            'GET /transactions',
        ],
    );
    const examples = openApiCurlExamples('https://danayasa.biz.id/api/v2/api');
    assert.match(examples, /MEMBER_ID/);
    assert.match(examples, /API_KEY/);
    assert.match(examples, /SECRET/);
    assert.match(examples, /SIGNATURE/);
    assert.match(examples, /REF_ID/);
    assert.doesNotMatch(examples, /tv_live_/);
    assert.doesNotMatch(examples, /MBR/);
    assert.match(examples, /https:\/\/danayasa\.biz\.id\/api\/v2\/api\/products/);
    assert.match(examples, /https:\/\/danayasa\.biz\.id\/api\/v2\/api\/order/);
});
