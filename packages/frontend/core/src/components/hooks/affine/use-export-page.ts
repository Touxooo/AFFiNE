import { notify } from '@affine/component';
import {
  pushGlobalLoadingEventAtom,
  resolveGlobalLoadingEventAtom,
} from '@affine/component/global-loading';
import type { AffineEditorContainer } from '@affine/core/blocksuite/block-suite-editor/blocksuite-editor';
import { DocsService } from '@affine/core/modules/doc';
import { DocsSearchService } from '@affine/core/modules/docs-search';
import { EditorService } from '@affine/core/modules/editor';
import { getAFFiNEWorkspaceSchema } from '@affine/core/modules/workspace/global-schema';
import { useI18n } from '@affine/i18n';
import { track } from '@affine/track';
import { ExportManager } from '@blocksuite/affine/blocks/surface';
import {
  docLinkBaseURLMiddleware,
  embedSyncedDocMiddleware,
  HtmlAdapterFactoryIdentifier,
  MarkdownAdapter,
  MarkdownAdapterFactoryIdentifier,
  titleMiddleware,
} from '@blocksuite/affine/shared/adapters';
import { printToPdf } from '@blocksuite/affine/shared/utils';
import type { BlockStdScope } from '@blocksuite/affine/std';
import {
  getAssetName,
  type Store,
  Transformer,
} from '@blocksuite/affine/store';
import {
  createAssetsArchive,
  download,
  HtmlTransformer,
  MarkdownTransformer,
  ZipTransformer,
} from '@blocksuite/affine/widgets/linked-doc';
import { useLiveData, useService } from '@toeverything/infra';
import * as fflate from 'fflate';
import { useSetAtom } from 'jotai';
import { nanoid } from 'nanoid';

import { useAsyncCallback } from '../affine-async-hooks';

type ExportType =
  | 'pdf'
  | 'html'
  | 'png'
  | 'markdown'
  | 'markdown-with-subpages'
  | 'snapshot';

interface ExportHandlerOptions {
  page: Store;
  editorContainer: AffineEditorContainer;
  type: ExportType;
  docsService: DocsService;
  docsSearchService: DocsSearchService;
}

interface AdapterResult {
  file: string;
  assetsIds: string[];
}

type AdapterFactoryIdentifier =
  | typeof HtmlAdapterFactoryIdentifier
  | typeof MarkdownAdapterFactoryIdentifier;

interface AdapterConfig {
  identifier: AdapterFactoryIdentifier;
  fileExtension: string; // file extension need to be lower case with dot prefix, e.g. '.md', '.txt', '.html'
  contentType: string;
  indexFileName: string;
}

class ZipWriter {
  private compressed = new Uint8Array();

  private finalize?: () => void;

  private finalized = false;

  private readonly zip = new fflate.Zip((err, chunk, final) => {
    if (!err) {
      const temp = new Uint8Array(this.compressed.length + chunk.length);
      temp.set(this.compressed);
      temp.set(chunk, this.compressed.length);
      this.compressed = temp;
    }
    if (final) {
      this.finalized = true;
      this.finalize?.();
    }
  });

  async file(path: string, content: Blob | string) {
    const deflate = new fflate.ZipDeflate(path);
    this.zip.add(deflate);
    if (typeof content === 'string') {
      deflate.push(fflate.strToU8(content), true);
    } else {
      deflate.push(new Uint8Array(await content.arrayBuffer()), true);
    }
  }

  async generate(): Promise<Blob> {
    this.zip.end();
    if (this.finalized) {
      return new Blob([this.compressed], { type: 'application/zip' });
    }
    return new Promise<Blob>(resolve => {
      this.finalize = () =>
        resolve(new Blob([this.compressed], { type: 'application/zip' }));
    });
  }
}

const RESERVED_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001F]/g;
const MAX_FILENAME_LENGTH = 80;

function sanitizeFileComponent(
  raw: string | null | undefined,
  fallback = 'Untitled'
) {
  const trimmed = (raw ?? '').replace(RESERVED_FILENAME_CHARS, '').trim();
  if (!trimmed) {
    return fallback;
  }
  const normalized = trimmed.replace(/\s+/g, ' ');
  const sliced = normalized.slice(0, MAX_FILENAME_LENGTH);
  return sliced.startsWith('.') ? `_${sliced}` : sliced;
}

function buildFolderSegment(title: string | null | undefined, docId: string) {
  return `${sanitizeFileComponent(title)}-${docId.slice(0, 6)}`;
}

async function collectLinkedDocIds(
  docId: string,
  docsSearchService: DocsSearchService
) {
  try {
    await docsSearchService.indexer.waitForDocCompleted(docId);
  } catch (error) {
    console.warn('[export] failed to wait for indexing', error);
  }

  try {
    const { nodes } = await docsSearchService.indexer.search(
      'block',
      {
        type: 'boolean',
        occur: 'must',
        queries: [
          {
            type: 'match',
            field: 'docId',
            match: docId,
          },
          {
            type: 'exists',
            field: 'refDocId',
          },
        ],
      },
      {
        fields: ['ref'],
        pagination: {
          limit: 500,
        },
      }
    );

    const result = new Set<string>();

    for (const node of nodes) {
      const field = node.fields.ref;
      const refs = Array.isArray(field) ? field : field ? [field] : [];
      for (const ref of refs) {
        if (typeof ref !== 'string') continue;
        try {
          const parsed = JSON.parse(ref) as { docId?: string };
          if (parsed.docId && parsed.docId !== docId) {
            result.add(parsed.docId);
          }
        } catch (error) {
          console.warn('[export] invalid doc reference payload', error);
        }
      }
    }

    return Array.from(result.values());
  } catch (error) {
    console.error('[export] failed to collect linked doc ids', error);
    return [];
  }
}

async function renderDocToMarkdown(
  doc: Store,
  std?: BlockStdScope
): Promise<{
  markdown: string;
  assets: Map<string, Blob>;
  assetIds: string[];
}> {
  if (std) {
    const transformer = new Transformer({
      schema: getAFFiNEWorkspaceSchema(),
      blobCRUD: doc.workspace.blobSync,
      docCRUD: {
        create: (id: string) => doc.workspace.createDoc(id).getStore({ id }),
        get: (id: string) => doc.workspace.getDoc(id)?.getStore({ id }) ?? null,
        delete: (id: string) => doc.workspace.removeDoc(id),
      },
      middlewares: [
        docLinkBaseURLMiddleware(doc.workspace.id),
        titleMiddleware(doc.workspace.meta.docMetas),
        embedSyncedDocMiddleware('content'),
      ],
    });

    const adapterFactory = std.store.provider.get(
      MarkdownAdapterFactoryIdentifier
    );
    const adapter = adapterFactory.get(transformer);
    const result = (await adapter.fromDoc(doc)) as AdapterResult | undefined;

    const assetsMap = transformer.assets ?? new Map<string, Blob>();
    if ((result?.assetsIds?.length ?? 0) > 0 && !transformer.assets) {
      throw new Error('No assets found');
    }

    return {
      markdown: result?.file ?? '',
      assets: assetsMap,
      assetIds: result?.assetsIds ?? [],
    };
  }

  const transformer = doc.getTransformer([
    docLinkBaseURLMiddleware(doc.workspace.id),
    titleMiddleware(doc.workspace.meta.docMetas),
    embedSyncedDocMiddleware('content'),
  ]);
  const snapshot = transformer.docToSnapshot(doc);
  if (!snapshot) {
    return {
      markdown: '',
      assets: transformer.assets ?? new Map<string, Blob>(),
      assetIds: [],
    };
  }
  const adapter = new MarkdownAdapter(transformer, doc.provider);
  const result = (await adapter.fromDocSnapshot({
    snapshot,
    assets: transformer.assetsManager,
  })) as AdapterResult;

  const assetsMap = transformer.assets ?? new Map<string, Blob>();
  if ((result?.assetsIds?.length ?? 0) > 0 && !transformer.assets) {
    throw new Error('No assets found');
  }

  return {
    markdown: result?.file ?? '',
    assets: assetsMap,
    assetIds: result?.assetsIds ?? [],
  };
}

async function exportMarkdownWithSubpages(options: {
  page: Store;
  std?: BlockStdScope;
  docsService: DocsService;
  docsSearchService: DocsSearchService;
}) {
  const { page, std, docsService, docsSearchService } = options;
  const visited = new Set<string>();
  const zip = new ZipWriter();

  const rootRecord = docsService.list.doc$(page.id).value;
  const rootTitle = rootRecord?.title$.value ?? page.meta?.title ?? 'Untitled';
  const rootSegment = buildFolderSegment(rootTitle, page.id);

  const addDocRecursive = async (
    docId: string,
    store: Store,
    pathSegments: string[]
  ) => {
    if (visited.has(docId)) {
      return;
    }
    visited.add(docId);

    const folderPath = pathSegments.join('/');
    const { markdown, assets, assetIds } = await renderDocToMarkdown(
      store,
      std
    );

    await zip.file(`${folderPath}/index.md`, markdown ?? '');

    if (assetIds.length > 0) {
      for (const assetId of assetIds) {
        const blob = assets.get(assetId);
        if (!blob) continue;
        const assetName = getAssetName(assets, assetId);
        await zip.file(`${folderPath}/assets/${assetName}`, blob);
      }
    }

    const linkedDocIds = await collectLinkedDocIds(docId, docsSearchService);
    if (linkedDocIds.length === 0) {
      return;
    }

    for (const childId of linkedDocIds) {
      if (visited.has(childId)) {
        continue;
      }

      const childRecord = docsService.list.doc$(childId).value;
      if (!childRecord) {
        continue;
      }
      if (childRecord.trash$.value) {
        continue;
      }

      let release: (() => void) | undefined;
      try {
        const { doc, release: releaseDoc } = docsService.open(childId);
        release = releaseDoc;
        await doc.waitForSyncReady().catch(() => undefined);

        const childTitle = childRecord.title$.value;
        const nextPath = [
          ...pathSegments,
          buildFolderSegment(childTitle, childId),
        ];

        await addDocRecursive(childId, doc.blockSuiteDoc, nextPath);
      } catch (error) {
        console.error('[export] failed to include linked doc', error);
      } finally {
        release?.();
      }
    }
  };

  await addDocRecursive(page.id, page, [rootSegment]);

  const archiveBlob = await zip.generate();
  const archiveNameBase = sanitizeFileComponent(rootTitle, 'Export');
  const archiveName = `${archiveNameBase}-with-subpages.zip`;
  download(archiveBlob, archiveName);
}

async function exportDoc(
  doc: Store,
  std: BlockStdScope,
  config: AdapterConfig
) {
  const transformer = new Transformer({
    schema: getAFFiNEWorkspaceSchema(),
    blobCRUD: doc.workspace.blobSync,
    docCRUD: {
      create: (id: string) => doc.workspace.createDoc(id).getStore({ id }),
      get: (id: string) => doc.workspace.getDoc(id)?.getStore({ id }) ?? null,
      delete: (id: string) => doc.workspace.removeDoc(id),
    },
    middlewares: [
      docLinkBaseURLMiddleware(doc.workspace.id),
      titleMiddleware(doc.workspace.meta.docMetas),
      embedSyncedDocMiddleware('content'),
    ],
  });

  const adapterFactory = std.store.provider.get(config.identifier);
  const adapter = adapterFactory.get(transformer);
  const result = (await adapter.fromDoc(doc)) as AdapterResult;

  if (!result || (!result.file && !result.assetsIds.length)) {
    return;
  }

  const docTitle = doc.meta?.title || 'Untitled';
  const contentBlob = new Blob([result.file], { type: config.contentType });

  let downloadBlob: Blob;
  let name: string;

  if (result.assetsIds.length > 0) {
    if (!transformer.assets) {
      throw new Error('No assets found');
    }
    const zip = await createAssetsArchive(transformer.assets, result.assetsIds);
    await zip.file(config.indexFileName, contentBlob);
    downloadBlob = await zip.generate();
    name = `${docTitle}.zip`;
  } else {
    downloadBlob = contentBlob;
    name = `${docTitle}${config.fileExtension}`;
  }

  download(downloadBlob, name);
}

async function exportToHtml(doc: Store, std?: BlockStdScope) {
  if (!std) {
    // If std is not provided, we use the default export method
    await HtmlTransformer.exportDoc(doc);
  } else {
    await exportDoc(doc, std, {
      identifier: HtmlAdapterFactoryIdentifier,
      fileExtension: '.html',
      contentType: 'text/html',
      indexFileName: 'index.html',
    });
  }
}

async function exportToMarkdown(doc: Store, std?: BlockStdScope) {
  console.log(doc);
  if (!std) {
    // If std is not provided, we use the default export method
    await MarkdownTransformer.exportDoc(doc);
  } else {
    await exportDoc(doc, std, {
      identifier: MarkdownAdapterFactoryIdentifier,
      fileExtension: '.md',
      contentType: 'text/plain',
      indexFileName: 'index.md',
    });
  }
}

async function exportHandler({
  page,
  type,
  editorContainer,
  docsService,
  docsSearchService,
}: ExportHandlerOptions) {
  const editorRoot = document.querySelector('editor-host');
  track.$.sharePanel.$.export({
    type,
  });
  switch (type) {
    case 'html':
      await exportToHtml(page, editorRoot?.std);
      return;
    case 'markdown':
      await exportToMarkdown(page, editorRoot?.std);
      return;
    case 'markdown-with-subpages':
      await exportMarkdownWithSubpages({
        page,
        std: editorRoot?.std,
        docsService,
        docsSearchService,
      });
      return;
    case 'snapshot':
      await ZipTransformer.exportDocs(
        page.workspace,
        getAFFiNEWorkspaceSchema(),
        [page]
      );
      return;
    case 'pdf':
      await printToPdf(editorContainer);
      return;
    case 'png': {
      await editorRoot?.std.get(ExportManager).exportPng();
      return;
    }
  }
}

export const useExportPage = () => {
  const editor = useService(EditorService).editor;
  const docsService = useService(DocsService);
  const docsSearchService = useService(DocsSearchService);
  const editorContainer = useLiveData(editor.editorContainer$);
  const blocksuiteDoc = editor.doc.blockSuiteDoc;
  const pushGlobalLoadingEvent = useSetAtom(pushGlobalLoadingEventAtom);
  const resolveGlobalLoadingEvent = useSetAtom(resolveGlobalLoadingEventAtom);
  const t = useI18n();

  const onClickHandler = useAsyncCallback(
    async (type: ExportType) => {
      if (editorContainer === null) return;

      // editor container is wrapped by a proxy, we need to get the origin
      const originEditorContainer = (editorContainer as any)
        .origin as AffineEditorContainer;

      const globalLoadingID = nanoid();
      pushGlobalLoadingEvent({
        key: globalLoadingID,
      });
      try {
        await exportHandler({
          page: blocksuiteDoc,
          type,
          editorContainer: originEditorContainer,
          docsService,
          docsSearchService,
        });
        notify.success({
          title: t['com.affine.export.success.title'](),
          message: t['com.affine.export.success.message'](),
        });
      } catch (err) {
        console.error(err);
        notify.error({
          title: t['com.affine.export.error.title'](),
          message: t['com.affine.export.error.message'](),
        });
      } finally {
        resolveGlobalLoadingEvent(globalLoadingID);
      }
    },
    [
      blocksuiteDoc,
      editorContainer,
      docsSearchService,
      docsService,
      pushGlobalLoadingEvent,
      resolveGlobalLoadingEvent,
      t,
    ]
  );

  return onClickHandler;
};
