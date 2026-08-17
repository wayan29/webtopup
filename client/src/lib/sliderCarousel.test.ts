import assert from 'node:assert/strict';
import test from 'node:test';
import {
    classifyPublicSliderLink,
    normalizeSlideIndex,
    shouldAutoRotate,
    swipeDirection,
} from './sliderCarousel.ts';

test('inactive links are never interactive and auto rotation respects all pause sources', () => {
    assert.equal(shouldAutoRotate({ reducedMotion: true, userPaused: false, hovered: false, focusWithin: false, count: 3 }), false);
    assert.equal(shouldAutoRotate({ reducedMotion: false, userPaused: false, hovered: false, focusWithin: false, count: 3 }), true);
});

test('public links reject legacy http and dangerous internal paths', () => {
    assert.equal(classifyPublicSliderLink('http://example.com').href, null);
    assert.equal(classifyPublicSliderLink('/%2e%2e/admin').href, null);
    assert.equal(classifyPublicSliderLink('https://example.com').external, true);
});

test('normalizes negative indexes and safely handles count shrink', () => {
    assert.equal(normalizeSlideIndex(-1, 3), 2);
    assert.equal(normalizeSlideIndex(-4, 3), 2);
    assert.equal(normalizeSlideIndex(5, 3), 2);
    assert.equal(normalizeSlideIndex(4, 2), 0);
    assert.equal(normalizeSlideIndex(8, 0), 0);
});

test('swipe threshold and vertical dominance are respected', () => {
    assert.equal(swipeDirection({ x: 10, y: 20 }, { x: 45, y: 20 }, 40), 0);
    assert.equal(swipeDirection({ x: 10, y: 20 }, { x: 55, y: 22 }, 40), 1);
    assert.equal(swipeDirection({ x: 100, y: 20 }, { x: 45, y: 22 }, 40), -1);
    assert.equal(swipeDirection({ x: 10, y: 10 }, { x: 80, y: 100 }, 40), 0);
    assert.equal(swipeDirection({ x: 10, y: 100 }, { x: 80, y: 10 }, 40), 0);
});

test('empty carousel has a stable index and never auto-rotates', () => {
    assert.equal(normalizeSlideIndex(3, 0), 0);
    assert.equal(shouldAutoRotate({ reducedMotion: false, userPaused: false, hovered: false, focusWithin: false, count: 0 }), false);
});

test('every automatic rotation pause source disables rotation', () => {
    const base = { reducedMotion: false, userPaused: false, hovered: false, focusWithin: false, count: 2 };
    assert.equal(shouldAutoRotate({ ...base, userPaused: true }), false);
    assert.equal(shouldAutoRotate({ ...base, hovered: true }), false);
    assert.equal(shouldAutoRotate({ ...base, focusWithin: true }), false);
});

test('explicit play is informed opt-in until the user pauses again', () => {
    const blocked = { reducedMotion: true, userPaused: false, hovered: true, focusWithin: true, count: 3, informedPlay: true };
    assert.equal(shouldAutoRotate(blocked), true);
    assert.equal(shouldAutoRotate({ ...blocked, userPaused: true }), false);
    assert.equal(shouldAutoRotate({ ...blocked, informedPlay: false }), false);
});

test('public slider links preserve safe internal query fragments and reject traversal', () => {
    assert.deepEqual(classifyPublicSliderLink('/promo?source=home#offers'), { href: '/promo?source=home#offers', external: false });
    assert.equal(classifyPublicSliderLink('//example.com/promo').href, null);
    assert.equal(classifyPublicSliderLink('\\\\example.com\\promo').href, null);
    assert.equal(classifyPublicSliderLink('/promo/../admin').href, null);
    assert.equal(classifyPublicSliderLink('/%2e%2E/admin').href, null);
    assert.equal(classifyPublicSliderLink('/promo%2f%2e%2e/admin').href, null);
    assert.equal(classifyPublicSliderLink('/promo%ZZ').href, null);
    assert.equal(classifyPublicSliderLink('/promo\u0000').href, null);
    assert.equal(classifyPublicSliderLink(' https://example.com/promo?x=1#top ').href, 'https://example.com/promo?x=1#top');
    assert.equal(classifyPublicSliderLink('https://user:pass@example.com/promo').href, null);
});
