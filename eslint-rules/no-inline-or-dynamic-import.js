/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow inline type imports and dynamic import(); use top-level static imports.",
    },
    schema: [],
    messages: {
      inlineType:
        "Use a top-level type import instead of inline import(...) type.",
      dynamic: "Use a top-level static import instead of dynamic import().",
    },
  },
  create(context) {
    return {
      TSImportType(node) {
        context.report({ node, messageId: "inlineType" });
      },
      ImportExpression(node) {
        context.report({ node, messageId: "dynamic" });
      },
    };
  },
};
