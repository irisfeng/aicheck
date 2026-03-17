const codePattern = /^(\d+(?:\.\d+)+)(?:-(\d+))?(?:$|[-_\s(（])/;
const globalEvidencePattern = /(安扫报告|扫描报告|漏洞扫描|scan report|security scan)/i;

function stripExtension(fileName) {
  const index = fileName.lastIndexOf(".");
  return index === -1 ? fileName : fileName.slice(0, index);
}

export function inferEvidenceRouting(fileName, checklistCodes) {
  const baseName = stripExtension(fileName).trim();
  const match = baseName.match(codePattern);
  const matchedCode = match?.[1] ?? "";
  const linkedCodes =
    matchedCode && checklistCodes.has(matchedCode) ? [matchedCode] : [];
  const globalEvidence = globalEvidencePattern.test(baseName);

  let namingHint = "未命中自动归档规则";
  if (linkedCodes.length > 0) {
    namingHint = `按文件名前缀自动归档到 ${linkedCodes.join(", ")}`;
  } else if (globalEvidence) {
    namingHint = "识别为全局报告材料，将参与全部条目判定";
  }

  return {
    linkedCodes,
    globalEvidence,
    namingHint,
  };
}

export function buildEvidenceIndex(checklist, evidences) {
  const directByCode = Object.fromEntries(checklist.map((item) => [item.code, []]));
  const globalEvidences = evidences.filter((evidence) => evidence.globalEvidence);

  for (const evidence of evidences) {
    for (const code of evidence.linkedCodes) {
      if (!directByCode[code]) {
        directByCode[code] = [];
      }
      directByCode[code].push(evidence);
    }
  }

  return {
    directByCode,
    globalEvidences,
  };
}
