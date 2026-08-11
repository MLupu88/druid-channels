// Phase 3A: pure unit tests for the shared canonical company-domain helper.
// No DB, no live provider -- companyIdentity.ts has zero DB/network imports.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toRegistrableDomain, isKnownNonCorporateDomain } from "../src/services/companyIdentity";

// ---- A. same-company subdomain family collapses to one registrable domain --

test("A: uipath.com, www.uipath.com, ir.uipath.com, careers.uipath.com all -> uipath.com", () => {
  assert.equal(toRegistrableDomain("uipath.com"), "uipath.com");
  assert.equal(toRegistrableDomain("www.uipath.com"), "uipath.com");
  assert.equal(toRegistrableDomain("ir.uipath.com"), "uipath.com");
  assert.equal(toRegistrableDomain("careers.uipath.com"), "uipath.com");
});

// ---- B. multi-label public suffix -------------------------------------------

test("B: example.co.uk and shop.example.co.uk both -> example.co.uk, never truncated to co.uk", () => {
  assert.equal(toRegistrableDomain("example.co.uk"), "example.co.uk");
  assert.equal(toRegistrableDomain("shop.example.co.uk"), "example.co.uk");
});

// ---- C. full URLs / case / path / query / port / trailing dot --------------

test("C: full URLs with scheme, path, and query normalize to the bare registrable domain", () => {
  assert.equal(toRegistrableDomain("https://uipath.com/blog/post-1?utm=x"), "uipath.com");
  assert.equal(toRegistrableDomain("http://ir.uipath.com/investors"), "uipath.com");
});

test("C: mixed case normalizes to lowercase", () => {
  assert.equal(toRegistrableDomain("HTTPS://WWW.UiPath.COM/Careers"), "uipath.com");
});

test("C: a port in the URL does not leak into the registrable domain", () => {
  assert.equal(toRegistrableDomain("https://uipath.com:8443/app"), "uipath.com");
});

test("C: a trailing root-zone dot is stripped before suffix parsing", () => {
  assert.equal(toRegistrableDomain("uipath.com."), "uipath.com");
});

test("C: a bare hostname with no scheme is accepted the same as a full URL", () => {
  assert.equal(toRegistrableDomain("uipath.com"), toRegistrableDomain("https://uipath.com"));
});

// ---- null-safety: never fabricate a domain for unsafe input ----------------

test("null/empty/whitespace-only input returns null, never a fabricated domain", () => {
  assert.equal(toRegistrableDomain(null), null);
  assert.equal(toRegistrableDomain(undefined), null);
  assert.equal(toRegistrableDomain(""), null);
  assert.equal(toRegistrableDomain("   "), null);
});

test("unparseable or non-registrable input (IP address, localhost, garbage) returns null", () => {
  assert.equal(toRegistrableDomain("localhost"), null);
  assert.equal(toRegistrableDomain("192.168.1.1"), null);
  assert.equal(toRegistrableDomain("not a domain at all"), null);
});

// ---- platform host sharing: private-registry subdomains stay distinct ------

test("a private-registry-hosted subdomain (e.g. a PaaS domain) keeps its own identity, never collapsed to the shared parent", () => {
  // Deliberate choice (allowPrivateDomains: true, see companyIdentity.ts) --
  // two different companies both hosted on the same PaaS must not be
  // silently merged into one canonical identity.
  assert.equal(toRegistrableDomain("acme.vercel.app"), "acme.vercel.app");
  assert.equal(toRegistrableDomain("other-co.vercel.app"), "other-co.vercel.app");
});

// ---- D. evidence-host guard --------------------------------------------------

test("D: known non-corporate/platform domains are flagged by the guard", () => {
  assert.equal(isKnownNonCorporateDomain("linkedin.com"), true);
  assert.equal(isKnownNonCorporateDomain("youtube.com"), true);
  assert.equal(isKnownNonCorporateDomain("youtu.be"), true);
  assert.equal(isKnownNonCorporateDomain("indeed.com"), true);
  assert.equal(isKnownNonCorporateDomain("glassdoor.com"), true);
});

test("D: an ordinary corporate domain is never flagged by the guard", () => {
  assert.equal(isKnownNonCorporateDomain("uipath.com"), false);
  assert.equal(isKnownNonCorporateDomain(null), false);
  assert.equal(isKnownNonCorporateDomain(undefined), false);
});
