const globalEvidencePattern = /(安扫报告|扫描报告|漏洞扫描|scan report|security scan)/i;

function stripExtension(fileName) {
  const index = fileName.lastIndexOf(".");
  return index === -1 ? fileName : fileName.slice(0, index);
}

function hasValidBoundary(remainder) {
  if (!remainder) return true;

  const firstChar = remainder[0];
  return firstChar !== "." && !/\d/u.test(firstChar);
}

function inferLinkedCodes(baseName, checklistCodes) {
  const sortedCodes = [...checklistCodes].sort((left, right) => right.length - left.length);

  for (const code of sortedCodes) {
    if (!baseName.startsWith(code)) {
      continue;
    }

    const remainder = baseName.slice(code.length);
    if (hasValidBoundary(remainder)) {
      return [code];
    }
  }

  return [];
}

export function inferEvidenceRouting(fileName, checklistCodes) {
  const baseName = stripExtension(fileName).trim();
  const linkedCodes = inferLinkedCodes(baseName, checklistCodes);
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
