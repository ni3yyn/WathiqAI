# Wathiq Intelligence MVP

Standalone cross-platform Agent API for Wathiq using Groq.

## Overview
This project provides a standalone Node.js (Fastify + TypeScript) API that receives natural language product requests, invokes the Groq LLM with tools, and interacts with the existing Wathiq backend APIs to search, retrieve, and evaluate products.

## Prerequisites
- Node.js
- Yarn

## Installation
1. Clone or download the repository.
2. Install dependencies:
   ```bash
   yarn install
   ```

## Configuration
Copy `.env.example` to `.env` and set your `GROQ_API_KEY`.
```bash
cp .env.example .env
```
Ensure `WATHIQ_EVALUATE_URL` and `WATHIQ_CATALOG_URL` point to the correct live URLs or local instances.

## Running Locally

To start the development server:
```bash
yarn dev
```

To build and start for production:
```bash
yarn build
yarn start
```
The server will run on `http://localhost:3001` (or your configured `PORT`).

## Testing the API

Send a POST request to `/api/chat`:

```bash
curl -X POST http://localhost:3001/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "I want an Algerian skin serum for oily skin and brightening claims."}'
```
