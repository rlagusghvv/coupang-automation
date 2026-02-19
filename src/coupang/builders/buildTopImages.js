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

  return [
    { imageOrder: 0, imageType: "REPRESENTATION", vendorPath: u },
  ];
}
