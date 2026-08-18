import assert from 'node:assert/strict';
import test from 'node:test';
import {
    canActivateSlider,
    formatArchivedMeta,
    sliderPositionLabel,
    sliderStatusLabel,
} from './sliderPresentation.ts';

const fullActiveLimits = {
    total: 20,
    active: 8,
    currentTotal: 8,
    currentActive: 8,
    remainingTotal: 12,
    remainingActive: 0,
};

test('archive status never masquerades as draft', () => {
    assert.equal(sliderStatusLabel('archive', false), 'Diarsipkan');
    assert.equal(sliderStatusLabel('archive', true), 'Diarsipkan');
    assert.equal(sliderStatusLabel('current', true), 'Aktif');
    assert.equal(sliderStatusLabel('current', false), 'Draft');
});

test('active-capacity guard blocks new and draft publication but not an existing active edit', () => {
    assert.equal(canActivateSlider(fullActiveLimits, false), false);
    assert.equal(canActivateSlider(fullActiveLimits, true), true);
    assert.equal(canActivateSlider({ ...fullActiveLimits, remainingActive: 1 }, false), true);
    assert.equal(canActivateSlider(undefined, false), false);
});

test('mobile position remains authoritative when filtered or archived', () => {
    assert.equal(sliderPositionLabel({ sortOrder: 4, total: 10, filtered: false, archived: false }), 'Posisi 5 dari 10');
    assert.equal(sliderPositionLabel({ sortOrder: 4, total: 2, filtered: true, archived: false }), 'Urutan asli 5');
    assert.equal(sliderPositionLabel({ sortOrder: 4, total: 2, filtered: false, archived: true }), 'Urutan terakhir 5');
});

test('archive metadata is shown only when a valid archive timestamp exists', () => {
    assert.match(formatArchivedMeta({
        _id: '1', name: 'Promo', image: '/uploads/covers/a.webp', link: '',
        sortOrder: 0, status: false, lifecycle: 'archived',
        archivedAt: '2026-08-17T12:00:00.000Z', archivedBy: 'operator-1',
    }) ?? '', /Diarsipkan/);
    assert.equal(formatArchivedMeta({
        _id: '2', name: 'Promo', image: '/uploads/covers/a.webp', link: '',
        sortOrder: 0, status: false, lifecycle: 'archived', archivedAt: null,
    }), null);
    assert.equal(formatArchivedMeta({
        _id: '3', name: 'Promo', image: '/uploads/covers/a.webp', link: '',
        sortOrder: 0, status: false, lifecycle: 'archived', archivedAt: 'not-a-date',
    }), null);
});
