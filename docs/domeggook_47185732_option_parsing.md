# Domeggook item 47185732 - option parsing notes (EUC-KR)

This note is based on the local file:
`/Users/kimhyeonho/Desktop/view-source_https___domeggook.com_47185732_from=lstBiz.html`

The HTML is EUC-KR and wrapped by Chrome `view-source` markup.
Option data is **not** in static HTML selects. It is injected by JS.

---

## Where the real option data lives

The option data is embedded in an inline script that creates
`ItemOptionController` instances.
There are two UI targets (`pay` and `sticky`), but both use the same data.

```js
window.lItem.optController[market][key] = new ItemOptionController({
  selQuery : '.lOptSel[data-key=' + key + '][data-market=' + market + ']',
  resQuery : '.lOptRes[data-key=' + key + '][data-market=' + market + ']',
  market   : 'dome',

  // ---------------------------
  // OPTION DATA (parse this)
  // ---------------------------
  data     : {
    "type": "combination",         // 2-level combination options
    "optSort": "DA",               // sorting order (site-specific)

    // option groups (levels)
    "set": {
      "0": {
        "name": "기종",            // group name
        "opts": {
          "0": "Z폴드4(5공용)",
          "1": "Z폴드6",
          "2": "Z폴드7"
        },
        "domPrice": {"0": 0, "1": 0, "2": 0},
        "changeKey": {"0": 0, "1": 1, "2": 2}
      },
      "1": {
        "name": "선택",
        "opts": {
          "0": "01 사생활 보호 유리 필름",
          "1": "02 지문 인식 풀유리 필름",
          "2": "03 강화 유리 지문 인식 필름"
        },
        "domPrice": {"0": 600, "1": 0, "2": -700},
        "changeKey": {"0": 0, "1": 1, "2": 2}
      }
    },

    // original copy of set (same meaning)
    "orgSet": { ... },

    // all combinations (key = index0_index1)
    "data": {
      "00_00": {"name": "Z폴드4(5공용)/01 사생활 보호 유리 필름", "dom": 1, "domPrice": 600,  "qty": 991,  "hid": 0},
      "00_01": {"name": "Z폴드4(5공용)/02 지문 인식 풀유리 필름", "dom": 1, "domPrice": 0,   "qty": 970,  "hid": 0},
      "00_02": {"name": "Z폴드4(5공용)/03 강화 유리 지문 인식 필름", "dom": 1, "domPrice": -700,"qty": 969,  "hid": 0},

      "01_00": {"name": "Z폴드6/01 사생활 보호 유리 필름", "dom": 1, "domPrice": 600,  "qty": 987,  "hid": 0},
      "01_01": {"name": "Z폴드6/02 지문 인식 풀유리 필름", "dom": 1, "domPrice": 0,   "qty": 999,  "hid": 0},
      "01_02": {"name": "Z폴드6/03 강화 유리 지문 인식 필름", "dom": 1, "domPrice": -700,"qty": 959,  "hid": 0},

      "02_00": {"name": "Z폴드7/01 사생활 보호 유리 필름", "dom": 1, "domPrice": 600,  "qty": 9945, "hid": 0},
      "02_01": {"name": "Z폴드7/02 지문 인식 풀유리 필름", "dom": 1, "domPrice": 0,   "qty": 9986, "hid": 0},
      "02_02": {"name": "Z폴드7/03 강화 유리 지문 인식 필름", "dom": 1, "domPrice": -700,"qty": 9986, "hid": 0}
    }
  },

  // pricing / quantity rules
  amtDome  : 1600,   // base price (KRW) before option adjustments
  unitQty  : 5,      // minimum order quantity
  stock    : 35792,  // overall stock shown by page

  // callback when option changes
  onAction : function(actionName, code, qty) { ... }
});
```

---

## Key parsing facts (most important)

1) **옵션 UI DOM은 비어 있고, JS가 채움**
   - `.lOptSel` and `.lOptRes` are empty in raw HTML.
   - If you parse only static HTML, **옵션이 항상 비어 있음**.

2) **실제 옵션 데이터는 JSON 형태로 내장**
   - `ItemOptionController({ data: {...} })` 안의 `data`가 진짜 옵션.
   - 이 블록을 정확히 추출해야 함.

3) **조합 옵션 구조**
   - `type = "combination"` → 2단 옵션.
   - `set` = 각 옵션 그룹 (기종 / 선택).
   - `data` = 모든 조합 (00_00, 00_01 ...).

4) **가격 계산 구조**
   - 기본단가: `amtDome = 1600`원.
   - 각 조합마다 `domPrice`가 “추가/할인” 값으로 붙음.
   - 예: `domPrice = -700`이면 700원 할인.

5) **재고 정보**
   - 각 조합에 `qty`가 있음 (해당 조합 재고).

---

## Minimal extraction strategy (safe)

1) Find the script that contains:
   `new ItemOptionController({`.

2) Inside that object, locate the `data:` property.

3) Extract the JSON object for `data` by **brace matching**.
   - Start at the `{` after `data:`
   - Count `{` and `}` until they balance.

4) Parse the extracted text as JSON.

---

## Why previous option parsing failed

- The page builds options **after load** using JS.
- If you only scrape HTML (static), you get **zero options**.
- Correct way: parse the inline JSON in the script.

---

## Context recap (to avoid future confusion)

- Source file: `/Users/kimhyeonho/Desktop/view-source_https___domeggook.com_47185732_from=lstBiz.html`
- Reconstructed raw HTML used for analysis (UTF-8 output):
  `/tmp/domeggook_47185732_source_euckr.html`
- Option data location:
  `ItemOptionController({ data: {...} })`

