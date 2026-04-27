export async function assertResponseIsOK(response, errorName) {
    if (!response.ok) {
        const errorMessage = `${errorName} ${response.status}`;
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
            const body = await response.json().catch(() => ({}));
            const message = errorMessage + ": " + (body?.message || body?.error || JSON.stringify(body));
            throw new Error(String(message));
        } else if (contentType.includes('text/')) {
            const body = await response.text().catch(() => ({}));
            const message = errorMessage + ": " + body;
            throw new Error(String(message));
        }
        throw new Error(errorMessage);
    }
}