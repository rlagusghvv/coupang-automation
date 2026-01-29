export function validateDraft(draft) {
  const required = ["sourceUrl", "title", "price", "imageUrl"];

  for (const k of required) {
    if (!draft || !draft[k]) {
      throw new Error("Draft missing: " + k);
    }
  }

  if (Number.isNaN(Number(draft.price))) {
    throw new Error("Draft price must be number");
  }

  return draft;
}

function floorTo10Won(n) {
  const x = Number(n);
  if (Number.isNaN(x)) return NaN;
  return Math.floor(x / 10) * 10;
}

export function makeDraft({
  sourceUrl,
  title,
  price,
  imageUrl,
  contentText = "",
}) {
  return validateDraft({
    sourceUrl: String(sourceUrl).trim(),
    title: String(title).trim(),
    price: floorTo10Won(price), // ✅ 여기
    imageUrl: String(imageUrl).trim(),
    contentText: String(contentText || "").trim(),
  });
}
