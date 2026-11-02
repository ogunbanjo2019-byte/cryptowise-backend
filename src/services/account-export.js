const MAX_ROWS_PER_COLLECTION = 1000;

const SAFE_CSV_HEADERS = [
  'recordType',
  'id',
  'createdAt',
  'updatedAt',
  'asset',
  'amountAtomic',
  'status',
  'kind',
  'network',
  'txHash',
  'destination',
  'email',
  'displayName',
  'kycStatus',
  'availableAtomic',
  'reservedAtomic',
];

function iso(value) {
  if (!value) return '';
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (typeof value.toMillis === 'function') {
    return new Date(value.toMillis()).toISOString();
  }
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function row(recordType, id, data = {}) {
  const out = { recordType, id };

  for (const key of SAFE_CSV_HEADERS.slice(2)) {
    const value = data[key];
    out[key] = value == null
      ? ''
      : key === 'createdAt' || key === 'updatedAt'
        ? iso(value)
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value);
  }

  return out;
}

function csvCell(value) {
  let text = String(value ?? '');

  // Prevent spreadsheet formula injection, including after common whitespace prefixes.
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(text)) {
    text = `'${text}`;
  }

  return `"${text.replace(/"/g, '""')}"`;
}

export function createAccountExport({
  uid,
  profile = {},
  account = {},
  ledger = [],
  deposits = [],
  withdrawals = [],
  truncated = {},
}) {
  const wasTruncated = Object.values(truncated).some(Boolean);

  const records = [
    row('export_metadata', uid, {
      status: wasTruncated
        ? 'truncated_at_1000_rows_per_collection'
        : 'complete_within_export_limits',
    }),
    row('profile', uid, {
      email: profile.email,
      displayName: profile.displayName,
      kycStatus: profile.kycStatus,
    }),
    row('wallet', uid, {
      availableAtomic: account.availableAtomic || {},
      reservedAtomic: account.reservedAtomic || {},
      updatedAt: account.updatedAt,
    }),
    ...ledger.map((item) => row('ledger', item.id, {
      createdAt: item.createdAt,
      asset: item.asset,
      amountAtomic: item.amountAtomic,
      kind: item.kind,
      txHash: item.txHash,
      status: item.status,
    })),
    ...deposits.map((item) => row('deposit', item.id, {
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      asset: item.asset,
      amountAtomic:
        item.verifiedAmountAtomic ||
        item.reviewedAmountAtomic ||
        item.amountAtomic,
      status: item.status,
      network: item.network,
      txHash: item.txHash,
    })),
    ...withdrawals.map((item) => row('withdrawal', item.id, {
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      asset: item.asset,
      amountAtomic: item.amountAtomic,
      status: item.status,
      network: item.network,
      txHash: item.txHash,
      destination: item.destination,
    })),
  ];

  const csv = [
    SAFE_CSV_HEADERS,
    ...records.map((record) =>
      SAFE_CSV_HEADERS.map((header) => record[header] ?? ''),
    ),
  ]
    .map((values) => values.map(csvCell).join(','))
    .join('\r\n');

  return { csv: `\uFEFF${csv}\r\n`, truncated };
}

export { MAX_ROWS_PER_COLLECTION };
