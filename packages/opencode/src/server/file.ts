import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { resolver } from "hono-openapi"
import z from "zod"
import { File } from "../file"
import { Snapshot } from "../snapshot"

export const FileRoute = new Hono()
  .get(
    "/",
    describeRoute({
      summary: "List files",
      description: "List files and directories in a specified path.",
      operationId: "file.list",
      responses: {
        200: {
          description: "Files and directories",
          content: {
            "application/json": {
              schema: resolver(File.Node.array()),
            },
          },
        },
      },
    }),
    validator(
      "query",
      z.object({
        path: z.string(),
      }),
    ),
    async (c) => {
      const path = c.req.valid("query").path
      const content = await File.list(path)
      return c.json(content)
    },
  )
  .get(
    "/content",
    describeRoute({
      summary: "Read file",
      description: "Read the content of a specified file.",
      operationId: "file.read",
      responses: {
        200: {
          description: "File content",
          content: {
            "application/json": {
              schema: resolver(File.Content),
            },
          },
        },
      },
    }),
    validator(
      "query",
      z.object({
        path: z.string(),
      }),
    ),
    async (c) => {
      const path = c.req.valid("query").path
      const content = await File.read(path)
      return c.json(content)
    },
  )
  .get(
    "/status",
    describeRoute({
      summary: "Get file status",
      description: "Get the git status of all files in the project.",
      operationId: "file.status",
      responses: {
        200: {
          description: "File status",
          content: {
            "application/json": {
              schema: resolver(File.Info.array()),
            },
          },
        },
      },
    }),
    async (c) => {
      const content = await File.status()
      return c.json(content)
    },
  )
  .get(
    "/diff",
    describeRoute({
      summary: "Get git diff list",
      description:
        "Get list of files with uncommitted changes. Returns file stats without diff lines (for lazy loading).",
      operationId: "file.diff",
      responses: {
        200: {
          description: "File diffs (without lines - use file.diffFile for full diff)",
          content: {
            "application/json": {
              schema: resolver(Snapshot.FileDiff.array()),
            },
          },
        },
      },
    }),
    async (c) => {
      const content = await File.diff()
      return c.json(content)
    },
  )
  .get(
    "/diff-file",
    describeRoute({
      summary: "Get git diff for single file",
      description: "Get full diff with lines for a specific file.",
      operationId: "file.diffFile",
      responses: {
        200: {
          description: "File diff with lines",
          content: {
            "application/json": {
              schema: resolver(Snapshot.FileDiff.nullable()),
            },
          },
        },
      },
    }),
    validator(
      "query",
      z.object({
        filepath: z.string().meta({ description: "File path relative to git root" }),
      }),
    ),
    async (c) => {
      const { filepath } = c.req.valid("query")
      const content = await File.diffFile(filepath)
      return c.json(content)
    },
  )
