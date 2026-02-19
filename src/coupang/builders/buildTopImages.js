export function buildTopImages({ url }) {
  const u = String(url || '').trim();
  if (!u) return [];

  // Wing uploader returns paths like: vendor_inventory/...jpg
  // For seller product API, this should be treated as cdnPath (and vendorPath can be same).
  if (u.startsWith('vendor_inventory/')) {
    return [
      { imageOrder: 0, imageType: "REPRESENTATION", cdnPath: u, vendorPath: u },
    ];
  }

  // External URL mode: set both cdnPath and vendorPath to the URL.
  // Some approvals reject when cdnPath is missing/invalid.
  return [
    { imageOrder: 0, imageType: "REPRESENTATION", cdnPath: u, vendorPath: u },
  ];
}
