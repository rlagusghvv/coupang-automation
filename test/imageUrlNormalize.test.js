import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDomeggookThumbOriginalUrl,
  expandCandidateImageUrls,
} from "../src/utils/imageUrlNormalize.js";

test("normalizeDomeggookThumbOriginalUrl extracts nested thumbOriginal url", () => {
  const nested =
    "https://api.example.com/img?thumbOriginal=" +
    encodeURIComponent("https://img.domeggook.com/files/a/b/c.jpg?x=1");

  assert.equal(
    normalizeDomeggookThumbOriginalUrl(nested),
    "https://img.domeggook.com/files/a/b/c.jpg?x=1",
  );
});

test("expandCandidateImageUrls returns https variant and no-query variant", () => {
  const base = "http://img.example.com/a/b/c.jpg?token=1";
  const list = expandCandidateImageUrls(base);
  assert.ok(list.includes("http://img.example.com/a/b/c.jpg?token=1"));
  assert.ok(list.includes("https://img.example.com/a/b/c.jpg?token=1"));
  assert.ok(list.includes("http://img.example.com/a/b/c.jpg"));
});
