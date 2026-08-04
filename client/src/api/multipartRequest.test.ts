import assert from 'node:assert/strict';
import test from 'node:test';
import axios from 'axios';

import { multipartRequestConfig } from './multipartRequest';

/**
 * The shared apiV2 instance declares `Content-Type: application/json` as an instance default.
 * Axios inspects that header when serializing: when a JSON content type is present it converts a
 * FormData body into a JSON object instead of sending multipart, so the gateway's multipart parser
 * finds no file and answers "Failed to upload file". These tests pin the contract that any FormData
 * post must override the instance default.
 */

function jsonHeaders() {
    return axios.AxiosHeaders.from({ 'Content-Type': 'application/json' });
}

function transform(body: unknown, headers: ReturnType<typeof jsonHeaders>) {
    const transformRequest = axios.defaults.transformRequest as unknown as Array<
        (data: unknown, headers: unknown) => unknown
    >;
    return transformRequest[0].call({}, body, headers);
}

test('a JSON content type turns a FormData body into JSON, losing the file', () => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'a.png');

    const serialized = transform(form, jsonHeaders());

    assert.equal(typeof serialized, 'string', 'axios JSON-ifies FormData when the header says JSON');
});

test('the multipart config overrides the instance default so FormData survives', () => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'a.png');

    const headers = jsonHeaders();
    const config = multipartRequestConfig();
    for (const [name, value] of Object.entries(config.headers)) {
        headers.set(name, value);
    }

    const serialized = transform(form, headers);

    assert.ok(serialized instanceof FormData, 'FormData must pass through untouched');
});

test('the multipart config declares a multipart content type', () => {
    assert.equal(multipartRequestConfig().headers['Content-Type'], 'multipart/form-data');
});
