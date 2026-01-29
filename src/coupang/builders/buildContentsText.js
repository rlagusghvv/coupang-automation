export function buildContentsText({ text }) {
  return [
    {
      contentsType: "TEXT",
      contentDetails: [{ detailType: "TEXT", content: text }],
    },
  ];
}
