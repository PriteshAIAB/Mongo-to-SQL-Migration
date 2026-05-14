const inquirer = require('inquirer');
const chalk = require('chalk');
const { getEditableLogicalTypeChoices, applyLogicalToColumn } = require('../utils/sqlTypes');

/**
 * @param {string} collectionName
 * @param {string} tableName
 * @param {{ sqlName: string, sqlDeclaration: string, sourceKey: string }[]} columns
 */
function printInferredSchema(collectionName, tableName, columns) {
  console.log(
    chalk.bold.cyan(`\n── Inferred SQL schema: ${chalk.white(collectionName)} → ${chalk.yellow(tableName)} ──`),
  );
  console.table(
    columns.map((c) => ({
      column: c.sqlName,
      sqlType: c.sqlDeclaration,
      mongoField: c.sourceKey,
    })),
  );
}

/**
 * Let user accept or tweak column SQL types before migration runs.
 * @param {string} collectionName
 * @param {string} tableName
 * @param {object[]} columns mutable inferred column objects
 */
async function promptSchemaReview(collectionName, tableName, columns) {
  if (!columns.length) {
    console.log(chalk.yellow('No columns inferred (empty sample or empty collection).'));
    return;
  }

  for (;;) {
    printInferredSchema(collectionName, tableName, columns);

    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'Schema looks correct?',
        choices: [
          { name: 'Yes — continue to migration', value: 'ok' },
          { name: 'No — change a column SQL type', value: 'edit' },
        ],
        default: 'ok',
      },
    ]);

    if (action === 'ok') {
      return;
    }

    const { sqlName } = await inquirer.prompt([
      {
        type: 'list',
        name: 'sqlName',
        message: 'Which column should be changed?',
        pageSize: 15,
        choices: columns.map((c) => ({
          name: `${c.sqlName}  (current: ${c.sqlDeclaration})`,
          value: c.sqlName,
        })),
      },
    ]);

    const { logical } = await inquirer.prompt([
      {
        type: 'list',
        name: 'logical',
        message: 'Pick the SQL type for this column:',
        choices: getEditableLogicalTypeChoices(),
      },
    ]);

    const col = columns.find((c) => c.sqlName === sqlName);
    if (col) {
      applyLogicalToColumn(col, logical);
      console.log(chalk.green(`Updated column "${sqlName}" → ${col.sqlDeclaration}`));
    }
  }
}

module.exports = { printInferredSchema, promptSchemaReview };
