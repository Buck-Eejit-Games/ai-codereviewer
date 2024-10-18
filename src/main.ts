import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";
import path from "path";

console.log("Starting AI Code Reviewer action... (initial log)");

// Log all inputs early to verify they are being set correctly
const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");
const includePatternsInput: string = core.getInput("include");

if (!GITHUB_TOKEN) {
  console.error("Error: GITHUB_TOKEN is missing.");
  process.exit(1);
}
if (!OPENAI_API_KEY) {
  console.error("Error: OPENAI_API_KEY is missing.");
  process.exit(1);
}
if (!OPENAI_API_MODEL) {
  console.error("Warning: OPENAI_API_MODEL is not provided. Defaulting to gpt-4o.");
}
if (!includePatternsInput) {
  console.error("Warning: include patterns are not provided.");
}

console.log("Inputs retrieved successfully:");
console.log("GITHUB_TOKEN: [REDACTED]");
console.log("OPENAI_API_KEY:", OPENAI_API_KEY);
console.log("OPENAI_API_MODEL:", OPENAI_API_MODEL);
console.log("Include patterns:", includePatternsInput);

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
  uniqueCommits: string[];
  branchName: string;
}

async function getPRDetails(): Promise<PRDetails> {
  console.log("Fetching PR details...");

  // Authenticate Octokit using GITHUB_TOKEN
  const token = core.getInput("GITHUB_TOKEN") || process.env.GITHUB_TOKEN;
  if (!token) {
    console.error("Error: GITHUB_TOKEN is required but not provided.");
    process.exit(1);
  }
  const octokit = new Octokit({auth: token});

  let pull_number: number | undefined;
  let owner: string | undefined;
  let repo: string | undefined;

  // Check for event path and read event data
  if (process.env.GITHUB_EVENT_PATH) {
    const eventData = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    if (eventData.pull_request) {
      pull_number = eventData.pull_request.number;
      owner = eventData.repository?.owner?.login;
      repo = eventData.repository?.name;
    } else if (eventData.inputs && eventData.inputs.pull_number) {
      pull_number = parseInt(eventData.inputs.pull_number, 10);
      owner = eventData.repository?.owner?.login;
      repo = eventData.repository?.name;
    }
  }

  // If GITHUB_EVENT_PATH does not provide necessary information, fallback to input
  if (!pull_number) {
    pull_number = parseInt(core.getInput("pull_number"));
    if (!pull_number) {
      console.error("Error: pull_number input is required but not provided.");
      process.exit(1);
    }
  }

  // Get owner and repo from GITHUB_REPOSITORY environment variable if not set
  if (!owner || !repo) {
    if (!process.env.GITHUB_REPOSITORY) {
      console.error("Error: GITHUB_REPOSITORY is not defined.");
      process.exit(1);
    }
    [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
  }

  if (!owner || !repo) {
    console.error("Error: Unable to determine repository owner and name.");
    process.exit(1);
  }

  console.log(`Repository details: owner=${owner}, repo=${repo}, pull_number=${pull_number}`);

  try {
    // Fetch pull request details using octokit
    const prResponse = await octokit.pulls.get({
      owner,
      repo,
      pull_number,
    });

    console.log("Successfully fetched PR details.");

    // Get unique commits for the pull request
    const uniqueCommits = await getUniquePRCommits(pull_number, owner, repo, octokit);

    return {
      owner,
      repo,
      pull_number,
      title: prResponse.data.title ?? "",
      description: prResponse.data.body ?? "",
      uniqueCommits,
      branchName: prResponse.data.head.ref // Extract the feature branch name from PR details
    };
  } catch (error: any) {
    console.error("Error fetching PR details:", error);
    if (error.status === 404) {
      console.error(`Error: Pull request #${pull_number} not found in repository ${owner}/${repo}.`);
    }
    process.exit(1);
  }
}

// async function getPRDetails(): Promise<PRDetails> {
//   console.log("Fetching PR details...");
//
//   // Authenticate Octokit using GITHUB_TOKEN
//   const token = core.getInput("GITHUB_TOKEN") || process.env.GITHUB_TOKEN;
//   if (!token) {
//     console.error("Error: GITHUB_TOKEN is required but not provided.");
//     process.exit(1);
//   }
//   const octokit = new Octokit({ auth: token });
//
//   let pull_number: number | undefined;
//   let owner: string | undefined;
//   let repo: string | undefined;
//
//   // Check for event path and read event data
//   if (process.env.GITHUB_EVENT_PATH) {
//     const eventData = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
//     if (eventData.pull_request) {
//       pull_number = eventData.pull_request.number;
//       owner = eventData.repository?.owner?.login;
//       repo = eventData.repository?.name;
//     } else if (eventData.inputs && eventData.inputs.pull_number) {
//       pull_number = parseInt(eventData.inputs.pull_number, 10);
//       owner = eventData.repository?.owner?.login;
//       repo = eventData.repository?.name;
//     }
//   }
//
//   // If GITHUB_EVENT_PATH does not provide necessary information, fallback to input
//   if (!pull_number) {
//     pull_number = parseInt(core.getInput("pull_number"));
//     if (!pull_number) {
//       console.error("Error: pull_number input is required but not provided.");
//       process.exit(1);
//     }
//   }
//
//   // Get owner and repo from GITHUB_REPOSITORY environment variable if not set
//   if (!owner || !repo) {
//     if (!process.env.GITHUB_REPOSITORY) {
//       console.error("Error: GITHUB_REPOSITORY is not defined.");
//       process.exit(1);
//     }
//     [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
//   }
//
//   if (!owner || !repo) {
//     console.error("Error: Unable to determine repository owner and name.");
//     process.exit(1);
//   }
//
//   console.log(`Repository details: owner=${owner}, repo=${repo}, pull_number=${pull_number}`);
//
//   try {
//     // Fetch pull request details using octokit
//     const prResponse = await octokit.pulls.get({
//       owner,
//       repo,
//       pull_number,
//     });
//
//     console.log("Successfully fetched PR details.");
//
//     // Get unique commits for the pull request
//     const uniqueCommits = await getUniquePRCommits(pull_number, owner, repo, octokit);
//
//     return {
//       owner,
//       repo,
//       pull_number,
//       title: prResponse.data.title ?? "",
//       description: prResponse.data.body ?? "",
//       uniqueCommits,
//     };
//   } catch (error: any) {
//     console.error("Error fetching PR details:", error);
//     if (error.status === 404) {
//       console.error(`Error: Pull request #${pull_number} not found in repository ${owner}/${repo}.`);
//     }
//     process.exit(1);
//   }
// }

async function getUniquePRCommits(pull_number: number, owner: string, repo: string, octokit: Octokit): Promise<string[]> {
  console.log(`Fetching unique commits for PR #${pull_number}...`);

  try {
    const reviewerUsername = "Peadar"; // Hardcoded reviewer username

    // Get the commits of the current pull request
    const currentPRCommits = await octokit.pulls.listCommits({
      owner,
      repo,
      pull_number,
    });

    const currentCommitShas = currentPRCommits.data.map((commit) => commit.sha);
    console.log(`Current PR commit SHAs:`, currentCommitShas);

    // Get all other open pull requests for the repository
    const allPRs = await octokit.pulls.list({
      owner,
      repo,
      state: "open",
    });

    const reviewedCommitShas = new Set<string>();

    // Collect commits of all other open pull requests reviewed by the specific user
    for (const pr of allPRs.data) {
      if (pr.number !== pull_number) {
        // Step 1: Check if the specified user has reviewed this PR
        const reviews = await octokit.pulls.listReviews({
          owner,
          repo,
          pull_number: pr.number,
        });

        const hasUserReviewed = reviews.data.some(
            (review) => review.user?.login?.includes(reviewerUsername)
        );

        if (hasUserReviewed) {
          console.log(`User ${reviewerUsername} has reviewed PR #${pr.number}`);
          // Step 2: Get commits of this reviewed PR
          const commits = await octokit.pulls.listCommits({
            owner,
            repo,
            pull_number: pr.number,
          });

          for (const commit of commits.data) {
            reviewedCommitShas.add(commit.sha);
          }
        } else {
          console.log(`User ${reviewerUsername} has NOT reviewed PR #${pr.number}`);
        }
      }
    }

    console.log(`Reviewed commits by user ${reviewerUsername}:`, Array.from(reviewedCommitShas));

    // Step 3: Filter out commits that have already been reviewed by the specified user
    const uniqueCommits = currentCommitShas.filter((sha) => !reviewedCommitShas.has(sha));

    console.log(`Unique commits for PR #${pull_number}:`, uniqueCommits);
    return uniqueCommits;
  } catch (error: any) {
    console.error("Error fetching unique commits:", error);
    throw error; // Let the caller handle the error
  }
}

// async function getDiff(owner: string, repo: string, pull_number: number): Promise<string | null> {
//   console.log("Fetching diff for PR...");
//
//   try {
//     const pullRequest = await octokit.pulls.get({
//       owner,
//       repo,
//       pull_number,
//     });
//
//     // Get base and head SHAs of the PR
//     const baseSha = pullRequest.data.base.sha;
//     const headSha = pullRequest.data.head.sha;
//
//     console.log(`Comparing commits between base: ${baseSha} and head: ${headSha}`);
//
//     const response = await octokit.repos.compareCommits({
//       owner,
//       repo,
//       base: baseSha,
//       head: headSha,
//       headers: {
//         accept: "application/vnd.github.v3.diff",
//       },
//     });
//
//     return String(response.data);
//   } catch (error: any) {
//     console.error("Error fetching PR diff:", error);
//     return null;
//   }
// }

async function getDiff(
    owner: string,
    repo: string,
    pull_number: number
): Promise<string | null> {
  console.log("Fetching commits for PR to create a filtered diff...");

  try {
    // Step 1: Get the list of commits in the PR
    const pullCommits = await octokit.pulls.listCommits({
      owner,
      repo,
      pull_number,
    });

    const baseBranch = "testing"; // This is your base branch name, e.g., "testing"

    // Step 2: Identify merge commits that are from the base branch ("testing")
    const mergeCommits = pullCommits.data.filter(commit => {
      return commit.commit.message.startsWith("Merge branch '" + baseBranch + "'");
    });

    if (mergeCommits.length > 0) {
      console.log("Found merge commits from the base branch:", mergeCommits.map(c => c.sha));
    }

    // Step 3: Filter out the commits that are merge commits from "testing"
    const filteredCommits = pullCommits.data.filter(commit => {
      return !mergeCommits.includes(commit);
    });

    console.log("Filtered commits (excluding merges from base branch):", filteredCommits.map(c => c.sha));

    if (filteredCommits.length === 0) {
      console.log("No unique commits found in this PR.");
      return null;
    }

    // Step 4: Compare each commit individually to create a diff
    let diff = "";
    for (const commit of filteredCommits) {
      const response = await octokit.repos.getCommit({
        owner,
        repo,
        ref: commit.sha,
        headers: {
          accept: "application/vnd.github.v3.diff",
        },
      });

      diff += String(response.data) + "\n";
    }

    return diff;
  } catch (error: any) {
    console.error("Error fetching filtered diff:", error);
    return null;
  }
}

async function analyzeCode(
    parsedDiff: File[],
    prDetails: PRDetails
): Promise<Array<{ body: string; path: string; line: number }>> {
  console.log("Analyzing code...");
  const comments: Array<{ body: string; path: string; line: number }> = [];

  for (const file of parsedDiff) {
    console.log("Processing file:", file.to);
    if (file.to === "/dev/null") continue; // Ignore deleted files
    for (const chunk of file.chunks) {
      console.log("Processing chunk");
      const prompt = createPrompt(file, chunk, prDetails);
      console.log("Prompt sent to OpenAI"); // Log the prompt
      try {
        const aiResponse = await getAIResponse(prompt);
        const parsedResponse = JSON.parse(aiResponse);
        //console.log("Parsed response from OpenAI:", parsedResponse); // Log the parsed response
        if (aiResponse) {
          const newComments = createComment(file, chunk, aiResponse);
          if (newComments) {
            comments.push(...newComments);
          }
        }
      } catch (error) {
        console.error("Error getting AI response:", error);
      }
    }
  }
  return comments;
}

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
  return `Your task is to review pull requests. Instructions:
- Provide the response in the following JSON format:  {"reviews": [{"lineNumber":  <line_number>, "reviewComment": "<review comment>"}]}
- NEVER talk about comments in the code or adding comments. (IMPORTANT)
- Do not give positive comments or compliments.
- Assume any variable you come across is defined, initialized and used correctly. (IMPORTANT)
- Assume any function you come across is defined, works and used correctly. (IMPORTANT)
- If code is removed, assume it was necessary to remove it unless you have reference to the full context and don't comment on it.
- STOP comment on renaming variable names, function names, or parameter names, unless they are completely incorrect.
- STOP commenting on checking for null or undefined unless it is completely incorrect.
- STOP commenting on formatting.
- STOP commenting about checking for zero or invalid values.
- Remember to be aware of up to date coding practices.
- Provide suggestions ONLY if there is something to improve, and provide reasons for it, otherwise "reviews" should be an empty array.
- Always try to provide code examples or snippets to support your suggestions.
- Context is important, so make sure to provide suggestions based on the context of the code and not to invent new context.
- If there is no context, assume it is a part of a valid function or method.
- Ensure you differentiate between code in different files.
- If provide code suggestions, if they are single line wrap them in single backticks, if they are multi-line wrap them in triple backticks on separate lines.
- If you do not know the context of the code, you can assume it is a part of a function or method, and you can assume the function signature or variable type is correct.
- Write the comment in GitHub Markdown format.
- Use the given description only for the overall context and only comment the code.
- IMPORTANT: Provide JSON without wrapping it in code blocks.

Review the following code diff in the file "${
      file.to
  }" and take the pull request title and description into account when writing the response.
  
Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Git diff to review:

\`\`\`diff
${chunk.content}
${chunk.changes
      // @ts-expect-error - ln and ln2 exists where needed
      .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
      .join("\n")}
\`\`\`
`;
}

function sanitizeAIResponse(response: string): string {
  // Remove code block markers if they exist
  return response.replace(/```(?:json)?|```/g, "").trim();
}

async function getAIResponse(prompt: string): Promise<string> {
  console.log("Sending prompt to OpenAI...");
  const queryConfig = {
    model: OPENAI_API_MODEL,
    temperature: 0.2,
    max_tokens: 700,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  try {
    const response = await openai.chat.completions.create({
      ...queryConfig,
      messages: [
        {
          role: "system",
          content: prompt,
        },
      ],
    });

    //console.log("OpenAI response received (raw):", response);
    let res = response.choices[0].message?.content?.trim() || "{}";

    // Sanitize response before returning
    res = sanitizeAIResponse(res);

    return res;
  } catch (error) {
    console.error("Error getting AI response:", error);
    console.error("Prompt that caused error:", prompt);
    return "{}";
  }
}

function createComment(
    file: File,
    chunk: Chunk,
    aiResponse: string
): Array<{ body: string; path: string; line: number }> {
  try {
    const reviews = JSON.parse(aiResponse).reviews;
    return reviews.flatMap((review: { lineNumber: string; reviewComment: string }) => {
      if (!file.to) {
        return [];
      }
      return {
        body: review.reviewComment,
        path: file.to,
        line: Number(review.lineNumber),
      };
    });
  } catch (error) {
    console.error("Error parsing AI response JSON:", error);
    console.error("AI response was:", aiResponse);
    return [];
  }
}

async function createReviewComment(
    owner: string,
    repo: string,
    pull_number: number,
    comments: Array<{ body: string; path: string; line?: number }>
): Promise<void> {
  console.log("Fetching pull request files...");

  // Step 1: Fetch files and their diff information from the pull request
  const prFiles = await octokit.pulls.listFiles({
    owner,
    repo,
    pull_number,
  });

  const fileDiffs = prFiles.data;

  // A helper function to get the diff position for a specific line in a file
  const getDiffPosition = (path: string, line: number | undefined): number | null => {
    if (!line) return null;

    const fileDiff = fileDiffs.find(file => file.filename === path);
    if (!fileDiff || !fileDiff.patch) return null;

    // Extract diff information for the file
    const diffLines = fileDiff.patch.split("\n");

    let currentLineInDiff = 0;
    let positionInDiff = 0;

    for (let i = 0; i < diffLines.length; i++) {
      const diffLine = diffLines[i];
      positionInDiff++; // Always increment the position

      // Lines starting with @@ indicate a new hunk with line numbers
      if (diffLine.startsWith("@@")) {
        const match = diffLine.match(/@@ \-(\d+),\d+ \+(\d+),\d+ @@/);
        if (match) {
          const startingLine = parseInt(match[2], 10);
          currentLineInDiff = startingLine;
        }
      } else if (!diffLine.startsWith("-")) {
        // Increment line number count only for lines that aren't removed (not starting with "-")
        currentLineInDiff++;
      }

      // If we've reached the requested line, return the position
      if (currentLineInDiff === line) {
        return positionInDiff;
      }
    }

    return null;
  };

  const formattedComments: Array<{ body: string; path: string; position?: number }> = [];

  for (const comment of comments) {
    const diffPosition = getDiffPosition(comment.path, comment.line);

    if (diffPosition !== null && diffPosition !== undefined) {
      console.log(`Adding comment "${comment.body}" to ${comment.path} at line ${comment.line} with diff position ${diffPosition}`);
      // Step 2: Add valid line-specific comments with diff position
      formattedComments.push({
        body: comment.body,
        path: comment.path,
        position: diffPosition // Use diff position
      });
    } else {
      //console.log(`Invalid or missing line number for ${comment.path}, skipping.`);
      // Step 3: Fallback to general file-level comments if no valid diff position
      formattedComments.push({
        body: comment.body,
        path: comment.path, // General file comment, omit position
        position: 1
      });
      console.warn(`Invalid or missing line number (${comment.line}) for comment "${comment.body}" at ${comment.path}, adding as a file-level comment.`);
    }
  }

  // Step 4: Submit the review with all collected comments
  if (formattedComments.length > 0) {
    console.log("Submitting collected review comments...");
    await octokit.pulls.createReview({
      owner,
      repo,
      pull_number,
      comments: formattedComments,
      event: "COMMENT",
    });
    console.log("Review comments submitted successfully.");
  } else {
    console.log("No valid comments to submit.");
  }
}

// async function main() {
//   console.log("Starting main function...");
//   const prDetails = await getPRDetails();
//   let diff: string | null;
//   const eventData = JSON.parse(
//       readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
//   );
//
//   console.log("Event action:", process.env.GITHUB_EVENT_NAME);
//   console.log(process.env.GITHUB_EVENT_NAME === "workflow_dispatch");
//
//   if (eventData.action === "opened" || process.env.GITHUB_EVENT_NAME === "workflow_dispatch") {
//     diff = await getDiff(
//         prDetails.owner,
//         prDetails.repo,
//         prDetails.pull_number
//     );
//   } else if (eventData.action === "synchronize") {
//     const newBaseSha = eventData.before;
//     const newHeadSha = eventData.after;
//
//     console.log("Fetching diff for synchronized event...");
//     const response = await octokit.repos.compareCommits({
//       headers: {
//         accept: "application/vnd.github.v3.diff",
//       },
//       owner: prDetails.owner,
//       repo: prDetails.repo,
//       base: newBaseSha,
//       head: newHeadSha,
//     });
//
//     diff = String(response.data);
//   } else {
//     console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
//     return;
//   }
//
//   if (!diff) {
//     console.log("No diff found");
//     return;
//   }
//
//   console.log("Diff found, parsing...");
//   const parsedDiff = parseDiff(diff);
//   parsedDiff.forEach(file => console.log("Parsed file path:", file.to)); // Log parsed file paths
//   //console.log("Parsed Diff:", parsedDiff); // Log parsed diff
//
//   // Get include patterns or use a default value if not provided
//   let includePatternsInput: string = core.getInput("include") || "**/*.cs,**/*.yml";
//   includePatternsInput = includePatternsInput.trim() ? includePatternsInput : "**/*.cs,**/*.yml";
//
//   const includePatterns = includePatternsInput
//       .split(",")
//       .map((s) => s.trim())
//       .filter((s) => s.length > 0);
//
//   console.log("Include patterns:", includePatterns);
//
//   const filteredDiff = parsedDiff.filter((file) => {
//     const normalizedPath = path.normalize(file.to ?? "");
//     const match = includePatterns.some((pattern) => minimatch(normalizedPath, pattern));
//     //console.log(`Checking if file "${normalizedPath}" matches patterns:`, match);
//     return match;
//   });
//   //console.log("Filtered Diff:", filteredDiff); // Log filtered diff
//
//   if (filteredDiff.length === 0) {
//     console.log("No files matched the include patterns.");
//     return;
//   }
//
//   const comments = await analyzeCode(filteredDiff, prDetails);
//   if (comments.length > 0) {
//     console.log("Comments generated:", comments);
//     await createReviewComment(
//         prDetails.owner,
//         prDetails.repo,
//         prDetails.pull_number,
//         comments
//     );
//   } else {
//     console.log("No comments generated.");
//   }
// }

async function getDiffAgainstTestingBranch(
    owner: string,
    repo: string,
    featureBranch: string,
    baseBranch: string = "testing"
): Promise<string | null> {
  console.log(`Fetching diff for feature branch "${featureBranch}" against base branch "${baseBranch}"...`);

  try {
    const response = await octokit.repos.compareCommits({
      owner,
      repo,
      base: baseBranch,
      head: featureBranch,
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
    });

    return String(response.data);
  } catch (error: any) {
    console.error("Error fetching diff against base branch:", error);
    return null;
  }
}

async function getDiffExcludingTestingBranch(
    owner: string,
    repo: string,
    featureBranch: string,
    baseBranch: string = "testing"
): Promise<string | null> {
  console.log(`Fetching diff for feature branch "${featureBranch}" compared to base branch "${baseBranch}"...`);

  try {
    // Step 1: Compare the "testing" branch with the feature branch
    const response = await octokit.repos.compareCommits({
      owner,
      repo,
      base: baseBranch, // Compare directly against the base branch (testing)
      head: featureBranch, // With the head of the feature branch
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
    });

    return String(response.data); // Return the diff as a string
  } catch (error: any) {
    console.error("Error fetching diff between testing branch and feature branch:", error);
    return null;
  }
}

// async function getDiffExcludingTestingBranch(
//     owner: string,
//     repo: string,
//     featureBranch: string,
//     baseBranch: string = "testing"
// ): Promise<string | null> {
//   console.log(`Fetching diff for feature branch "${featureBranch}" excluding commits from base branch "${baseBranch}"...`);
//
//   try {
//     // Step 1: Compare the "testing" branch with the feature branch to get unique commits
//     const comparison = await octokit.repos.compareCommits({
//       owner,
//       repo,
//       base: baseBranch,
//       head: featureBranch,
//     });
//
//     const uniqueCommits = comparison.data.commits.map(commit => commit.sha);
//     if (uniqueCommits.length === 0) {
//       console.log("No unique commits found between the feature branch and the testing branch.");
//       return null;
//     }
//    
//     // Log the unique commits
//     uniqueCommits.forEach((sha, index) => console.log(`Unique commit #${index + 1}: ${sha}`));
//
//     // Step 2: Get the parent of the first unique commit
//     const firstCommitSha = uniqueCommits[0];
//     console.log(`Fetching parent commit for the first unique commit: ${firstCommitSha}...`);
//
//     const commitDetails = await octokit.repos.getCommit({
//       owner,
//       repo,
//       ref: firstCommitSha,
//     });
//
//     const parentSha = commitDetails.data.parents[0]?.sha;
//     if (!parentSha) {
//       console.error("Error: Unable to determine parent commit for the first unique commit.");
//       return null;
//     }
//
//     console.log(`Parent commit of the first unique commit is: ${parentSha}`);
//
//     // Step 3: Use the parent of the first unique commit as the base and the last unique commit as the head
//     const lastCommitSha = uniqueCommits[uniqueCommits.length - 1];
//     console.log(`Comparing commits between parent of first unique commit (${parentSha}) and last unique commit (${lastCommitSha})...`);
//
//     const response = await octokit.repos.compareCommits({
//       owner,
//       repo,
//       base: parentSha,
//       head: lastCommitSha,
//       headers: {
//         accept: "application/vnd.github.v3.diff",
//       },
//     });
//
//     return String(response.data);
//   } catch (error: any) {
//     console.error("Error fetching cumulative diff excluding testing branch commits:", error);
//     return null;
//   }
// }

async function main() {
  console.log("Starting main function...");
  const prDetails = await getPRDetails();

  const baseBranch = "testing";  // Always comparing against the "testing" branch
  const featureBranch = prDetails.branchName;  // Using the pull request's branch

  console.log(`Event action: ${process.env.GITHUB_EVENT_NAME}`);

  // Always compare the feature branch against "testing" to get the relevant diff
  //const diff = await getDiffAgainstTestingBranch(prDetails.owner, prDetails.repo, featureBranch, baseBranch);
  const diff = await getDiffExcludingTestingBranch(prDetails.owner, prDetails.repo, featureBranch);

  if (!diff) {
    console.log("No diff found");
    return;
  }

  console.log("Diff found, parsing...");
  const parsedDiff = parseDiff(diff);
  parsedDiff.forEach(file => console.log("Parsed file path:", file.to)); // Log parsed file paths

  // Get include patterns or use a default value if not provided
  let includePatternsInput: string = core.getInput("include") || "**/*.cs,**/*.yml";
  includePatternsInput = includePatternsInput.trim() ? includePatternsInput : "**/*.cs,**/*.yml";

  const includePatterns = includePatternsInput
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

  console.log("Include patterns:", includePatterns);

  // Filter files based on include patterns
  const filteredDiff = parsedDiff.filter((file) => {
    const normalizedPath = path.normalize(file.to ?? "");
    const match = includePatterns.some((pattern) => minimatch(normalizedPath, pattern));
    return match;
  });

  if (filteredDiff.length === 0) {
    console.log("No files matched the include patterns.");
    return;
  }

  // Analyze the code changes and generate comments
  const comments = await analyzeCode(filteredDiff, prDetails);
  if (comments.length > 0) {
    console.log("Comments generated:", comments);
    await createReviewComment(
        prDetails.owner,
        prDetails.repo,
        prDetails.pull_number,
        comments
    );
  } else {
    console.log("No comments generated.");
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});