export interface PdfExportChoice {
  includeEachBuildStage: boolean;
}

/** Ask for the one PDF-specific option without leaving the editor's UI. */
export function showPdfExportDialog(): Promise<PdfExportChoice | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'workflow-overlay';

    const dialog = document.createElement('section');
    dialog.className = 'workflow-dialog pdf-export-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'pdf-export-title');

    const title = document.createElement('h2');
    title.id = 'pdf-export-title';
    title.textContent = 'Export PDF';

    const option = document.createElement('label');
    option.className = 'field-check pdf-export-builds';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    const optionText = document.createElement('span');
    optionText.textContent = 'Include each stage of builds';
    option.append(checkbox, optionText);

    const actions = document.createElement('div');
    actions.className = 'workflow-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'primary';
    submit.textContent = 'Export';
    actions.append(cancel, submit);

    let finished = false;
    const finish = (choice: PdfExportChoice | null): void => {
      if (finished) return;
      finished = true;
      overlay.remove();
      resolve(choice);
    };
    cancel.addEventListener('click', () => finish(null));
    submit.addEventListener('click', () => finish({ includeEachBuildStage: checkbox.checked }));
    overlay.addEventListener('pointerdown', (event) => {
      if (event.target === overlay) finish(null);
    });
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') finish(null);
    });

    dialog.append(title, option, actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    checkbox.focus();
  });
}
