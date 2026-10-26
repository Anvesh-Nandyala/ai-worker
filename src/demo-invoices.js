// Validation for the practice app's invoice register, not model-side extraction.
export function invoiceRecord(input) {
  const record = {};
  for (const [key, limit] of [['company', 120], ['invoiceNumber', 80], ['source', 500]]) {
    if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > limit || /[\x00-\x1f]/.test(input[key])) throw new Error('Enter a valid ' + key);
    record[key] = input[key].trim();
  }
  if (typeof input.amount !== 'string' || !/^(0|[1-9]\d{0,8})(\.\d{1,2})?$/.test(input.amount)) throw new Error('Enter a positive amount with at most two decimal places');
  const [whole, fraction = ''] = input.amount.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents <= 0n) throw new Error('Amount must be greater than zero');
  record.amount = whole + '.' + fraction.padEnd(2, '0');
  if (!['INR', 'USD', 'EUR', 'GBP'].includes(input.currency)) throw new Error('Choose a supported currency');
  record.currency = input.currency;
  for (const key of ['invoiceDate', 'dueDate']) {
    const value = input[key];
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error('Enter a valid ' + key + ' as YYYY-MM-DD');
    record[key] = value;
  }
  if (record.dueDate < record.invoiceDate) throw new Error('Due date must not precede the invoice date');
  return record;
}

export function sameInvoice(a, b) {
  return a.company.toLowerCase() === b.company.toLowerCase() && a.invoiceNumber.toLowerCase() === b.invoiceNumber.toLowerCase();
}
