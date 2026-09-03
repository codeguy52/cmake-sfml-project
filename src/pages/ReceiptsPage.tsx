import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Cents, ParsedReceipt, Receipt } from '../types';
import { useStore } from '../store';
import { compressForStorage, recognizeReceipt, terminateOcr, type OcrProgress } from '../lib/ocr';
import { parseWarnings } from '../lib/receiptParser';
import { deleteReceipt, getAllReceipts, putReceipt } from '../lib/db';
import { newId } from '../lib/seed';
import { formatCents } from '../lib/money';
import {
  Callout,
  Card,
  ConfirmButton,
  EmptyState,
  Field,
  MoneyInput,
  useFormatMoney,
} from '../components/ui';

/**
 * Receipt capture.
 *
 * `capture="environment"` on a file input is what opens the rear camera on a
 * phone while still accepting a file on a desktop — one control, no separate
 * code path, and no getUserMedia permission prompt for a still photo.
 *
 * OCR output is always presented as an editable draft. The parser is good
 * enough to save typing and nowhere near good enough to trust silently, so
 * every field it guessed is shown filled in and flagged, and nothing is
 * committed until the user presses Save.
 */

type Stage = 'idle' | 'scanning' | 'review';

interface Draft {
  imageBlob: Blob;
  mimeType: string;
  previewUrl: string;
  ocrText: string;
  ocrConfidence: number;
  parsed: ParsedReceipt;
  merchant: string;
  date: string;
  amountCents: Cents;
  categoryId: string | null;
  subcategoryId: string | null;
  note: string;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function ReceiptsPage() {
  const data = useStore((s) => s.data);
  const { addTransaction, updateTransaction, removeTransaction } = useStore();
  const fmt = useFormatMoney();

  const [stage, setStage] = useState<Stage>('idle');
  const [progress, setProgress] = useState<OcrProgress | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRawText, setShowRawText] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const draftUrlRef = useRef<string | null>(null);

  const refreshReceipts = useCallback(async () => {
    const all = await getAllReceipts();
    setReceipts(all.sort((a, b) => b.capturedAt - a.capturedAt));
  }, []);

  useEffect(() => {
    void refreshReceipts();
  }, [refreshReceipts]);

  // The OCR worker holds a ~15 MB language model; drop it when the user leaves.
  useEffect(() => () => {
    void terminateOcr();
  }, []);

  // Release the preview object URL whenever it's replaced or the page unmounts.
  useEffect(() => () => {
    if (draftUrlRef.current) URL.revokeObjectURL(draftUrlRef.current);
  }, []);

  const handleFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith('image/')) {
        setError('That file is not an image. Take a photo or choose a JPEG or PNG.');
        return;
      }

      setError(null);
      setSaved(null);
      setStage('scanning');
      setProgress({ status: 'preparing image', progress: 0 });

      try {
        const { blob, mimeType } = await compressForStorage(file);

        if (draftUrlRef.current) URL.revokeObjectURL(draftUrlRef.current);
        const previewUrl = URL.createObjectURL(blob);
        draftUrlRef.current = previewUrl;

        const result = await recognizeReceipt(blob, setProgress);

        setDraft({
          imageBlob: blob,
          mimeType,
          previewUrl,
          ocrText: result.text,
          ocrConfidence: result.confidence,
          parsed: result.parsed,
          merchant: result.parsed.merchant ?? '',
          date: result.parsed.date ?? todayIso(),
          amountCents: result.parsed.totalCents ?? 0,
          categoryId: null,
          subcategoryId: null,
          note: '',
        });
        setStage('review');
      } catch (e) {
        setError(
          e instanceof Error
            ? `Could not read that image: ${e.message}`
            : 'Could not read that image.',
        );
        setStage('idle');
      } finally {
        setProgress(null);
      }
    },
    [],
  );

  // Desktop convenience: paste a screenshot straight in.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
      if (file) void handleFile(file);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [handleFile]);

  const selectedCategory = data.categories.find((c) => c.id === draft?.categoryId);

  const warnings = useMemo(
    () => (draft ? parseWarnings(draft.parsed) : []),
    [draft],
  );

  const discardDraft = (): void => {
    if (draftUrlRef.current) {
      URL.revokeObjectURL(draftUrlRef.current);
      draftUrlRef.current = null;
    }
    setDraft(null);
    setStage('idle');
    setShowRawText(false);
    if (fileInput.current) fileInput.current.value = '';
  };

  const saveDraft = async (): Promise<void> => {
    if (!draft) return;

    const receiptId = newId('rcpt');
    const transactionId = addTransaction({
      date: draft.date,
      amountCents: draft.amountCents,
      merchant: draft.merchant.trim() || 'Unknown merchant',
      categoryId: draft.categoryId,
      subcategoryId: draft.subcategoryId,
      note: draft.note.trim() || undefined,
      receiptId,
      source: 'receipt',
    });

    try {
      await putReceipt({
        id: receiptId,
        blob: draft.imageBlob,
        mimeType: draft.mimeType,
        capturedAt: Date.now(),
        ocrText: draft.ocrText,
        ocrConfidence: draft.ocrConfidence,
        parsed: draft.parsed,
        transactionId,
      });
      await refreshReceipts();
      setSaved(`Saved ${fmt(draft.amountCents)} at ${draft.merchant.trim() || 'unknown merchant'}.`);
    } catch {
      // The transaction is already recorded; drop the dangling photo reference
      // rather than leaving a link to an image that was never stored.
      updateTransaction(transactionId, { receiptId: undefined });
      setError('The transaction was saved but the photo could not be stored — storage may be full.');
    }

    discardDraft();
  };

  const linkedTransaction = (receipt: Receipt) =>
    data.transactions.find((t) => t.receiptId === receipt.id);

  return (
    <>
      <header className="page-header">
        <h1 className="page-title">Scan a receipt</h1>
        <p className="page-subtitle">
          Photograph a receipt and it's read on this device — the image and the text never leave
          your phone or computer. Check the amounts before saving; OCR gets creative with faded
          print.
        </p>
      </header>

      <div className="stack">
        {error && (
          <Callout tone="critical">
            {error}{' '}
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setError(null)}>
              Dismiss
            </button>
          </Callout>
        )}

        {saved && (
          <Callout tone="good">
            {saved}{' '}
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSaved(null)}>
              Dismiss
            </button>
          </Callout>
        )}

        {stage === 'idle' && (
          <Card>
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              capture="environment"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file);
              }}
            />
            <div
              className="dropzone"
              data-active={dragging}
              role="button"
              tabIndex={0}
              onClick={() => fileInput.current?.click()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  fileInput.current?.click();
                }
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const file = e.dataTransfer.files?.[0];
                if (file) void handleFile(file);
              }}
            >
              <div className="dropzone-icon" aria-hidden="true">
                ⬛
              </div>
              <div style={{ fontWeight: 600, marginBottom: 3 }}>Take a photo or choose an image</div>
              <div className="field-hint">
                On a phone this opens the camera. On a desktop you can drop a file here or paste from
                the clipboard.
              </div>
            </div>
            <div className="btn-row" style={{ marginTop: 12, justifyContent: 'center' }}>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setDraft({
                    imageBlob: new Blob(),
                    mimeType: '',
                    previewUrl: '',
                    ocrText: '',
                    ocrConfidence: 0,
                    parsed: { lineItems: [] },
                    merchant: '',
                    date: todayIso(),
                    amountCents: 0,
                    categoryId: null,
                    subcategoryId: null,
                    note: '',
                  });
                  setStage('review');
                }}
              >
                Enter one by hand instead
              </button>
            </div>
          </Card>
        )}

        {stage === 'scanning' && (
          <Card title="Reading the receipt">
            <p className="secondary" style={{ fontSize: 13, marginTop: 0 }}>
              {progress?.status
                ? progress.status.charAt(0).toUpperCase() + progress.status.slice(1)
                : 'Working'}
              …
            </p>
            <div className="progress-track">
              <div
                className="progress-fill"
                style={{ width: `${Math.round((progress?.progress ?? 0) * 100)}%` }}
              />
            </div>
            <p className="field-hint" style={{ marginBottom: 0 }}>
              The first scan downloads the recognition model (about 15 MB). Later scans are much
              faster and work offline.
            </p>
          </Card>
        )}

        {stage === 'review' && draft && (
          <Card
            title={draft.previewUrl ? 'Check what was read' : 'New transaction'}
            note={
              draft.previewUrl
                ? `Text confidence ${Math.round(draft.ocrConfidence)}%. Correct anything that looks wrong.`
                : undefined
            }
          >
            <div className="grid grid-2">
              {draft.previewUrl && (
                <div className="stack-sm">
                  <img src={draft.previewUrl} alt="The receipt you photographed" className="receipt-preview" />
                  {draft.ocrText && (
                    <>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => setShowRawText((v) => !v)}
                        aria-expanded={showRawText}
                      >
                        {showRawText ? 'Hide' : 'Show'} the text that was read
                      </button>
                      {showRawText && <pre className="ocr-text">{draft.ocrText}</pre>}
                    </>
                  )}
                </div>
              )}

              <div className="stack-sm">
                {warnings.length > 0 && draft.previewUrl && (
                  <Callout tone="warning">
                    <ul style={{ margin: 0, paddingLeft: 16 }}>
                      {warnings.map((w) => (
                        <li key={w}>{w}</li>
                      ))}
                    </ul>
                  </Callout>
                )}

                <Field label="Merchant">
                  {(id) => (
                    <input
                      id={id}
                      type="text"
                      value={draft.merchant}
                      placeholder="Where you spent it"
                      onChange={(e) => setDraft({ ...draft, merchant: e.target.value })}
                    />
                  )}
                </Field>

                <div className="form-row">
                  <Field label="Date">
                    {(id) => (
                      <input
                        id={id}
                        type="date"
                        value={draft.date}
                        onChange={(e) => setDraft({ ...draft, date: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field
                    label="Amount"
                    hint={
                      draft.parsed.subtotalCents !== undefined
                        ? `Subtotal read as ${fmt(draft.parsed.subtotalCents)}${draft.parsed.taxCents !== undefined ? `, tax ${fmt(draft.parsed.taxCents)}` : ''}`
                        : undefined
                    }
                  >
                    {(id) => (
                      <MoneyInput
                        id={id}
                        valueCents={draft.amountCents}
                        onCommit={(amountCents) => setDraft({ ...draft, amountCents })}
                      />
                    )}
                  </Field>
                </div>

                <div className="form-row">
                  <Field label="Category">
                    {(id) => (
                      <select
                        id={id}
                        value={draft.categoryId ?? ''}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            categoryId: e.target.value || null,
                            subcategoryId: null,
                          })
                        }
                      >
                        <option value="">Uncategorized</option>
                        {data.categories
                          .filter((c) => !c.archived)
                          .map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                      </select>
                    )}
                  </Field>
                  <Field label="Subcategory">
                    {(id) => (
                      <select
                        id={id}
                        value={draft.subcategoryId ?? ''}
                        disabled={!selectedCategory || selectedCategory.subcategories.length === 0}
                        onChange={(e) => setDraft({ ...draft, subcategoryId: e.target.value || null })}
                      >
                        <option value="">
                          {selectedCategory?.subcategories.length ? 'None' : 'No subcategories'}
                        </option>
                        {selectedCategory?.subcategories
                          .filter((s) => !s.archived)
                          .map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name}
                            </option>
                          ))}
                      </select>
                    )}
                  </Field>
                </div>

                <Field label="Note">
                  {(id) => (
                    <input
                      id={id}
                      type="text"
                      value={draft.note}
                      placeholder="Optional"
                      onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                    />
                  )}
                </Field>

                {draft.parsed.lineItems.length > 0 && (
                  <details>
                    <summary style={{ cursor: 'pointer', fontSize: 13 }} className="secondary">
                      {draft.parsed.lineItems.length} line items were read
                    </summary>
                    <div className="table-wrap" style={{ marginTop: 8 }}>
                      <table>
                        <tbody>
                          {draft.parsed.lineItems.map((item, i) => (
                            <tr key={`${item.description}-${i}`}>
                              <td>{item.description}</td>
                              <td className="num">{fmt(item.amountCents)}</td>
                              <td className="num">
                                <button
                                  type="button"
                                  className="btn btn-sm btn-ghost"
                                  title="Use this amount as the transaction total"
                                  onClick={() => setDraft({ ...draft, amountCents: item.amountCents })}
                                >
                                  Use
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                )}

                <div className="btn-row" style={{ marginTop: 4 }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={draft.amountCents === 0}
                    onClick={() => void saveDraft()}
                  >
                    Save transaction
                  </button>
                  <button type="button" className="btn" onClick={discardDraft}>
                    Discard
                  </button>
                  {draft.amountCents === 0 && (
                    <span className="field-hint">Enter an amount to save.</span>
                  )}
                </div>
              </div>
            </div>
          </Card>
        )}

        <Card
          title="Saved receipts"
          note={`${receipts.length} photo${receipts.length === 1 ? '' : 's'} stored on this device.`}
        >
          {receipts.length === 0 ? (
            <EmptyState icon="▢" title="No receipts saved yet">
              Scanned receipts are kept here alongside the transaction they created.
            </EmptyState>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Captured</th>
                    <th>Merchant</th>
                    <th className="num">Amount</th>
                    <th className="num">Confidence</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {receipts.map((r) => {
                    const txn = linkedTransaction(r);
                    return (
                      <tr key={r.id}>
                        <td className="secondary">
                          {new Date(r.capturedAt).toLocaleDateString(undefined, {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                          })}
                        </td>
                        <td>{txn?.merchant ?? r.parsed?.merchant ?? <span className="muted">Unknown</span>}</td>
                        <td className="num">
                          {txn
                            ? formatCents(txn.amountCents, {
                                currency: data.settings.currency,
                                locale: data.settings.locale,
                              })
                            : '—'}
                        </td>
                        <td className="num secondary">
                          {r.ocrConfidence !== undefined ? `${Math.round(r.ocrConfidence)}%` : '—'}
                        </td>
                        <td className="num">
                          <ConfirmButton
                            className="btn btn-sm btn-ghost"
                            confirmLabel="Delete both"
                            onConfirm={() => {
                              void (async () => {
                                // Deleting the transaction also drops its photo.
                                if (txn) await removeTransaction(txn.id);
                                else await deleteReceipt(r.id);
                                await refreshReceipts();
                              })();
                            }}
                          >
                            Delete
                          </ConfirmButton>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
