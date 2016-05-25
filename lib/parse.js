'use strict';

/**
 * The `kss/lib/parse` module is normally accessed via the
 * [`parse()`]{@link module:kss.parse} method of the `kss` module:
 * ```
 * const kss = require('kss');
 * let styleGuide = kss.parse(input, options);
 * ```
 * @private
 * @module kss/lib/parse
 */

const KssStyleGuide = require('./kss_style_guide.js'),
  marked = require('marked'),
  path = require('path'),
  docblockParser = require('docblock-parser');

// Create a MarkDown renderer that does not output a wrapping paragraph.
const inlineRenderer = new marked.Renderer();
inlineRenderer.paragraph = function(text) {
  return text;
};

/**
 * Parse an array/string of documented CSS, or an array of file objects with
 * their content.
 *
 * Each File object in the array should be formatted as:
 * `{ base: "path to source directory", path: "full path to file", contents: "content" }`.
 *
 * @alias module:kss.parse
 * @param {*} input The input to parse
 * @param {Object} [options] Options to alter the output content. Same as the
 *   options in [`traverse()`]{@link module:kss.traverse}.
 * @returns {KssStyleGuide} Returns a `KssStyleGuide` object.
 */
const parse = function(input, options) {
  // Default parsing options.
  options = options || {};
  if (typeof options.markdown === 'undefined') {
    options.markdown = true;
  }
  if (typeof options.header === 'undefined') {
    options.header = true;
  }
  options.custom = options.custom || [];

  // Massage our input into a "files" array of Vinyl-like objects.
  let files = [],
    styleGuide = {
      files: [],
      sections: []
    };

  // If supplied a string.
  if (typeof input === 'string') {
    files.push({
      contents: input
    });

  // If supplied an array of strings or objects.
  } else {
    files = input.map(file => {
      if (typeof file === 'string') {
        return {contents: file};
      } else {
        styleGuide.files.push(file.path);
        return file;
      }
    });
  }

  for (let file of files) {
    // Retrieve an array of "comment block" strings, and then evaluate each one.
    let comments = findCommentBlocks(file.contents);

    for (let comment of comments) {
      // Parse the docblock comment and store it
      const commentObject = docblockParser.parse(comment.raw);

      // Create a new, temporary section object with some default values.
      // "raw" is a comment block from the array above.
      let newSection = {
        raw: comment.raw,
        header: '',
        description: '',
        modifiers: [],
        parameters: [],
        markup: '',
        sourceFile: {
          name: file.path ? file.path : '',
          base: file.base ? file.base : '',
          path: file.path ? file.path : '',
          line: comment.line
        }
      };

      if (file.base) {
        // Always display using UNIX separators.
        newSection.sourceFile.name = path.relative(file.base, file.path).replace(/\\/g, '/');
      }

      // Parse styleguide
      newSection.reference = commentObject.tags.styleguide || false;
      
      // Ignore this docblock if a styleguide tag is undefined
      if (!newSection.reference) {
        continue;
      }

      // Parse header, if enabled
      if (options.header) {
        newSection.header = commentObject.text;
        newSection.header = newSection.header.replace(/\n/g, ' ');
      }

      // Parse description
      newSection.description = commentObject.tags.description || '';

      // Parse description with markdown, if enabled
      if (options.markdown) {
        newSection.description = marked(newSection.description);
      }

      // Parse modifiers
      let modifiers = commentObject.tags.modifier || '';

      if (modifiers !== '') {
        newSection.modifiers = newSection.modifiers.concat(modifiers);
        newSection.modifiers = createModifiers(newSection.modifiers, options);
      }

      // Parse parameters
      let parameters = commentObject.tags.param || '';

      if (parameters !== '') {
        newSection.parameters = newSection.parameters.concat(parameters);
        newSection.parameters = createParameters(newSection.parameters, options);
      }

      // Parse markup
      newSection.markup = commentObject.tags.markup || '';

      // Parse weight
      // If weight is not defined, return 0 otherwise parse the string into an int
      newSection.weight = isNaN(commentObject.tags.weight) ? 0 : parseInt(commentObject.tags.weight);

      // Parse deprecation and experimental status
      newSection.deprecated = typeof commentObject.tags.deprecated !== 'undefined';
      newSection.experimental = typeof commentObject.tags.experimental !== 'undefined';

      // Parse custom properties
      if (options.custom) {
        const custom = {};

        // Process custom properties.
        for (let customProperty of options.custom) {
          custom[customProperty] = commentObject.tags[customProperty] || '';
        }

        // Merge custom keys into newSection
        newSection = Object.assign(newSection, custom);
      }

      // Add the new section instance to the sections array.
      styleGuide.sections.push(newSection);
    }
  }

  return new KssStyleGuide(styleGuide);
};

/**
 * Returns an array of comment blocks found within a string.
 *
 * @private
 * @param  {String} input The string to search.
 * @returns {Array} An array of blocks found as objects containing line, text,
 *   and raw properties.
 */
const findCommentBlocks = function(input) {
  /* eslint-disable key-spacing */
  const commentRegex = {
    docblockStart: /^\s*\/\*\*\s*$/,
    multiStart:    /^\s*\/\*\*\s*$/,
    multiFinish:   /^\s*\*\/\s*$/
  };
  /* eslint-enable key-spacing */

  // Convert Windows/Mac line endings to Unix ones.
  input = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  let blocks = [],
    block = {
      line: 0,
      text: '',
      raw: ''
    },
    indentAmount = false,
    insideSingleBlock = false,
    insideMultiBlock = false,
    insideDocblock = false;

  // Add an empty line to catch any comment at the end of the input.
  input += '\n';
  const lines = input.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];

    // Remove trailing space.
    line = line.replace(/\s*$/, '');

    // If we have reached the end of the current block, save it.
    if (insideSingleBlock || (insideMultiBlock || insideDocblock) && line.match(commentRegex.multiFinish)) {
      let doneWithCurrentLine = !insideSingleBlock;
      block.text = block.text.replace(/^\n+/, '').replace(/\n+$/, '');
      blocks.push(block);
      insideMultiBlock = insideDocblock = insideSingleBlock = indentAmount = false;
      block = {
        line: 0,
        text: '',
        raw: ''
      };
      // If we "found" the end of a single-line comment block, we are not done
      // processing the current line and cannot skip the rest of this loop.
      if (doneWithCurrentLine) {
        continue;
      }
    }

    // Docblock parsing.
    if (line.match(commentRegex.docblockStart)) {
      insideDocblock = true;
      block.raw += line + '\n';
      block.line = i + 1;
      continue;
    }
    if (insideDocblock) {
      block.raw += line + '\n';
      // Add the current line (and a newline) minus the comment marker.
      block.text += line.replace(/^\s*\*\s?/, '') + '\n';
      continue;
    }
    // Multi-line parsing.
    if (line.match(commentRegex.multiStart)) {
      insideMultiBlock = true;
      block.raw += line + '\n';
      block.line = i + 1;
      continue;
    }
    if (insideMultiBlock) {
      block.raw += line + '\n';
      // If this is the first interior line, determine the indentation amount.
      if (indentAmount === false) {
        // Skip initial blank lines.
        if (line === '') {
          continue;
        }
        indentAmount = line.match(/^\s*/)[0];
      }
      // Always strip same indentation amount from each line.
      block.text += line.replace(new RegExp('^' + indentAmount), '', 1) + '\n';
    }
  }

  return blocks;
};

/**
 * Takes an array of modifier lines, and turns it into a JSON equivalent of
 * KssModifier.
 *
 * @private
 * @param {Array} rawModifiers Raw Modifiers, which should all be strings.
 * @param {Object} options The options object.
 * @returns {Array} The modifier instances created.
 */
const createModifiers = function(rawModifiers, options) {
  return rawModifiers.map(entry => {
    // Split modifier name and the description.
    let modifier = entry.split(/\s+\-\s+/, 1)[0];
    let description = entry.replace(modifier, '', 1).replace(/^\s+\-\s+/, '');

    // If description is multi-lined then strip line-breaks and variable spaces
    if (description.match(/\n/g)) {
      description = description.replace(/\n/g, ' ');
      description = description.replace(/([\s|\t]{2,})/g, ' ');
    }

    // Markdown parsing.
    if (options.markdown) {
      description = marked(description, {renderer: inlineRenderer});
    }

    return {
      name: modifier,
      description: description
    };
  });
};

/**
 * Takes an array of parameter lines, and turns it into instances of
 * KssParameter.
 *
 * @private
 * @param {Array} rawParameters Raw parameters, which should all be strings.
 * @param {Object} options The options object.
 * @returns {Array} The parameter instances created.
 */
const createParameters = function(rawParameters, options) {
  return rawParameters.map(entry => {
    // Split parameter name and the description.
    let parameter = entry.split(/\s+\-\s+/, 1)[0];
    let defaultValue = '';
    let description = entry.replace(parameter, '', 1).replace(/^\s+\-\s+/, '');

    // Split parameter name and the default value.
    if (/\s+=\s+/.test(parameter)) {
      let tokens = parameter.split(/\s+=\s+/);
      parameter = tokens[0];
      defaultValue = tokens[1];
    }

    // Markdown parsing.
    if (options.markdown) {
      description = marked(description, {renderer: inlineRenderer});
    }

    return {
      name: parameter,
      defaultValue: defaultValue,
      description: description
    };
  });
};

module.exports = parse;
